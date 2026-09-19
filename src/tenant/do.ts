// TenantDO — one Durable Object per hosted creator (R30 §3.1, and see the long comment at the
// top of runner.ts for why this object, and not a cheaper host, is the design).
//
// The object owns that tenant's comment queue, send pacing, poll slot, 613 cooldown, backlog
// sweep cursors and usage counters. Everything it does runs through TenantRunner, which
// serializes it: one runner per tenant, always. A viral post can exhaust its own object's run
// budget and nothing else.
//
// Alarms, not crons: each object re-arms its own alarm, so a tenant costs none of the account's
// 250 Cron Triggers, and an alarm that throws is retried for that tenant alone ("at-least-once
// execution ... exponential backoff starting at a 2 second delay ... up to 6 retries").

import { InstagramClient } from "../api/client";
import { refreshLongLivedToken } from "../api/client";
import type { HostedEnv, NormalizedEvent } from "../types";
import { TenantDb, now } from "./db";
import { UsageMeter } from "./metering";
import { TenantRunner } from "./runner";
import {
  getTenant,
  patchTenant,
  saveTenantToken,
  tenantAccessToken,
} from "./registry";
import type { TenantRow } from "./registry";

/** Polling cadence for tenants whose webhooks are not live yet. */
const POLL_INTERVAL_SECONDS = 90;
/** Backlog sweep cadence: catches anything that scrolled out of the newest-page window. */
const SWEEP_INTERVAL_SECONDS = 20 * 60;
/** Token refresh check, once a day (a long-lived token must be > 24h old to refresh). */
const REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;
/** Usage flush cadence, matching the meter's own 60s threshold. */
const USAGE_INTERVAL_SECONDS = 60;

const K_NEXT = "next:";

export class TenantDO implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: HostedEnv,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenant") ?? "";
    if (!tenantId) return json({ error: "missing tenant" }, 400);

    switch (url.pathname) {
      case "/events": {
        const body = (await req.json()) as { events?: NormalizedEvent[] };
        const parts = await this.parts(tenantId);
        if (!parts) return json({ error: "tenant not connected" }, 409);
        const report = await parts.runner.handleEvents(body.events ?? []);
        await this.arm(tenantId);
        return json({ ok: true, report });
      }
      case "/poll": {
        const parts = await this.parts(tenantId);
        if (!parts) return json({ error: "tenant not connected" }, 409);
        const report = await parts.runner.runPoll();
        await this.arm(tenantId);
        return json({ ok: true, report });
      }
      case "/sweep": {
        const parts = await this.parts(tenantId);
        if (!parts) return json({ error: "tenant not connected" }, 409);
        const report = await parts.runner.runSweep();
        await this.arm(tenantId);
        return json({ ok: true, report });
      }
      case "/subscribe": {
        const ok = await this.subscribeApps(tenantId);
        return json({ ok });
      }
      case "/refresh": {
        const status = await this.refreshToken(tenantId);
        return json({ ok: true, status });
      }
      case "/arm": {
        await this.arm(tenantId);
        return json({ ok: true });
      }
      case "/status": {
        const parts = await this.parts(tenantId);
        return json({
          ok: true,
          connected: parts !== null,
          paused_credit: parts ? await parts.runner.isPausedForCredit() : null,
          cooldown_until: parts ? await parts.runner.cooldownUntil() : null,
        });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /**
   * One alarm drives every scheduled job for this tenant. Each job stores its own next-due time;
   * the alarm fires for whichever is due, runs it, and re-arms for the earliest remaining.
   */
  async alarm(): Promise<void> {
    const tenantId = (await this.ctx.storage.get<string>("tenant_id")) ?? "";
    if (!tenantId) return;
    const tenant = await getTenant(this.env.DB, tenantId);
    if (!tenant || tenant.status === "disconnected") return;

    const t = now();
    const due = async (job: string, interval: number): Promise<boolean> => {
      const at = (await this.ctx.storage.get<number>(K_NEXT + job)) ?? 0;
      if (at > t) return false;
      await this.ctx.storage.put(K_NEXT + job, t + interval);
      return true;
    };

    const parts = await this.parts(tenantId);
    if (parts) {
      if (tenant.mode === "polling" && (await due("poll", POLL_INTERVAL_SECONDS))) {
        await parts.runner.runPoll();
      }
      if (await due("sweep", SWEEP_INTERVAL_SECONDS)) await parts.runner.runSweep();
      if (await due("usage", USAGE_INTERVAL_SECONDS)) await parts.runner.flushUsage(true);
    }
    if (await due("refresh", REFRESH_INTERVAL_SECONDS)) await this.refreshToken(tenantId);

    await this.arm(tenantId);
  }

  /** Re-arm for the earliest scheduled job. Cheap and idempotent. */
  private async arm(tenantId: string): Promise<void> {
    await this.ctx.storage.put("tenant_id", tenantId);
    const t = now();
    const jobs: Array<[string, number]> = [
      ["poll", POLL_INTERVAL_SECONDS],
      ["sweep", SWEEP_INTERVAL_SECONDS],
      ["usage", USAGE_INTERVAL_SECONDS],
      ["refresh", REFRESH_INTERVAL_SECONDS],
    ];
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const [job, interval] of jobs) {
      let at = await this.ctx.storage.get<number>(K_NEXT + job);
      if (at === undefined) {
        at = t + interval;
        await this.ctx.storage.put(K_NEXT + job, at);
      }
      earliest = Math.min(earliest, at);
    }
    await this.ctx.storage.setAlarm(Math.max(t + 1, earliest) * 1000);
  }

  /** Build this tenant's runner, or null when it has no usable token. */
  private async parts(tenantId: string): Promise<{ tenant: TenantRow; runner: TenantRunner } | null> {
    const tenant = await getTenant(this.env.DB, tenantId);
    if (!tenant) return null;
    const token = await tenantAccessToken(this.env, tenant);
    if (!token) return null;
    if (tenant.meta_token_expires_at !== null && tenant.meta_token_expires_at <= now()) {
      console.warn(`[chatmany] ${tenantId}: token lapsed; the creator must reconnect`);
      return null;
    }
    const db = new TenantDb(this.env.DB, tenantId);
    const client = new InstagramClient(token, this.env.GRAPH_VERSION, tenant.ig_user_id ?? "me");
    const meter = new UsageMeter({
      tenantId,
      publikUserId: tenant.publik_user_id,
      storage: this.ctx.storage,
      db,
      endpoint: this.env.PUBLIK_API_BASE,
      token: this.env.INFRA_INGEST_TOKEN,
    });
    const runner = new TenantRunner({
      tenantId,
      db,
      storage: this.ctx.storage,
      client,
      meter,
      igUserId: tenant.ig_user_id,
      onStatus: async (status, reason) => {
        await patchTenant(this.env.DB, tenantId, { status, paused_reason: reason });
      },
    });
    return { tenant, runner };
  }

  /**
   * Turn webhook deliveries on for this tenant. Meta requires it explicitly — "Your app must
   * enable subscriptions by sending a POST request to the /me/subscribed_apps endpoint" — and no
   * call to it existed anywhere in this repo, which is why the deployed Worker has always run on
   * polling (`/health` reports mode: polling to this day).
   */
  private async subscribeApps(tenantId: string): Promise<boolean> {
    const tenant = await getTenant(this.env.DB, tenantId);
    if (!tenant) return false;
    const token = await tenantAccessToken(this.env, tenant);
    if (!token) return false;
    const url = new URL(`https://graph.instagram.com/${this.env.GRAPH_VERSION}/me/subscribed_apps`);
    url.searchParams.set("subscribed_fields", "comments,messages");
    url.searchParams.set("access_token", token);
    try {
      const res = await fetch(url.toString(), { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        console.warn(`[chatmany] ${tenantId}: subscribed_apps returned ${res.status}`);
        return false;
      }
      // mode flips to 'webhook' only when a signed delivery actually arrives (routes/hosted.ts),
      // so an account whose webhooks never fire keeps being polled instead of going quiet.
      return true;
    } catch (e) {
      console.warn(`[chatmany] ${tenantId}: subscribed_apps failed (${e instanceof Error ? e.message : String(e)})`);
      return false;
    }
  }

  /**
   * Daily token refresh for this tenant. A long-lived token must be >24h old and unexpired;
   * refreshing extends it ~60 days. The creator is emailed by publik 7 days before expiry.
   */
  private async refreshToken(tenantId: string): Promise<string> {
    const tenant = await getTenant(this.env.DB, tenantId);
    if (!tenant) return "no_tenant";
    const token = await tenantAccessToken(this.env, tenant);
    if (!token) return "no_auth";
    const t = now();
    const expiresAt = tenant.meta_token_expires_at ?? 0;
    if (expiresAt <= t) {
      await patchTenant(this.env.DB, tenantId, {
        status: "paused_meta",
        paused_reason: "Instagram connection expired — reconnect to resume",
      });
      return "expired";
    }
    if (expiresAt - t > 30 * 86400) return "skipped";
    const lastSet = tenant.token_refreshed_at ?? expiresAt - 60 * 86400;
    if (t - lastSet < 86400 + 3600) return "too_new";
    try {
      const { access_token, expires_in } = await refreshLongLivedToken(this.env.GRAPH_VERSION, token);
      await saveTenantToken(this.env, tenantId, access_token, now() + expires_in);
      return "refreshed";
    } catch (e) {
      console.warn(`[chatmany] ${tenantId}: token refresh failed (${e instanceof Error ? e.message : String(e)})`);
      return "error";
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
