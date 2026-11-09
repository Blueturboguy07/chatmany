// Per-tenant surface that publik's dashboard proxies to (path T: one publik Meta app for every
// creator). Everything here is reached only through the /hosted/* control plane, which has
// already checked the INFRA_ADMIN_TOKEN and resolved the tenant row; the creator's browser never
// talks to this Worker.
//
// Two jobs:
//   1. Connect: publik sends the creator to Instagram's consent screen with the URL built here,
//      then hands the returned code back. The code exchange happens in this Worker, so the
//      Instagram token goes straight from Instagram into this tenant's encrypted column and never
//      passes through publik.
//   2. The same JSON API the self-host UI uses (routes/api.ts), bound to one tenant's rows.
//      Payloads are kept identical on purpose so one UI contract serves both.

import { InstagramApiError, InstagramClient } from "../api/client";
import { buildAuthorizeUrl, exchangeCodeForShortLivedToken, exchangeForLongLivedToken } from "../auth/oauth";
import { validateCampaign } from "../config";
import { TenantDb, now } from "../tenant/db";
import { getTenant, getTenantByIgUser, patchTenant, publicView, saveTenantToken, tenantAccessToken } from "../tenant/registry";
import type { TenantRow } from "../tenant/registry";
import type { HostedEnv } from "../types";
import { json } from "./http";

/** The shared publik Meta app (Instagram app id + secret). Absent on a path-L-only deployment. */
function sharedApp(env: HostedEnv): { appId: string; appSecret: string } | null {
  if (!env.APP_ID || !env.APP_SECRET) return null;
  return { appId: env.APP_ID, appSecret: env.APP_SECRET };
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** GET /hosted/tenants/{id}/authorize-url?redirect_uri=&state= — Instagram's consent URL. */
export function tenantAuthorizeUrl(env: HostedEnv, url: URL): Response {
  const app = sharedApp(env);
  if (!app) return fail(503, "shared_app_not_configured", "The Instagram connection is not set up yet.");
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!isHttpsUrl(redirectUri)) return fail(400, "bad_redirect_uri", "redirect_uri must be an https URL.");
  if (state.length < 16) return fail(400, "bad_state", "state must be at least 16 characters.");
  return json({ url: buildAuthorizeUrl(app.appId, redirectUri, state) });
}

/**
 * POST /hosted/tenants/{id}/oauth {code, redirect_uri} — exchange the code, check the account,
 * store the token encrypted under this tenant's id. Returns `connected: true` only when the
 * tenant row now holds a usable token, so the caller knows to subscribe and arm the object.
 */
export async function tenantOAuth(
  env: HostedEnv,
  tenant: TenantRow,
  req: Request,
): Promise<{ response: Response; connected: boolean }> {
  const no = (response: Response) => ({ response, connected: false });
  const app = sharedApp(env);
  if (!app) return no(fail(503, "shared_app_not_configured", "The Instagram connection is not set up yet."));

  const body = (await safeJson(req)) as { code?: unknown; redirect_uri?: unknown };
  const code = typeof body.code === "string" ? body.code.replace(/#_$/, "") : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  if (!code) return no(fail(400, "missing_code", "The authorization code is missing."));
  if (!isHttpsUrl(redirectUri)) return no(fail(400, "bad_redirect_uri", "redirect_uri must be an https URL."));

  let accessToken: string;
  let expiresIn: number;
  let shortUserId: string;
  try {
    const short = await exchangeCodeForShortLivedToken(app.appId, app.appSecret, redirectUri, code);
    console.log(`[chatmany] ${tenant.tenant_id}: OAuth granted ${JSON.stringify(short.permissions ?? "none reported")}`);
    shortUserId = short.userId;
    const long = await exchangeForLongLivedToken(env.GRAPH_VERSION, app.appSecret, short.accessToken);
    accessToken = long.accessToken;
    expiresIn = long.expiresIn;
  } catch (e) {
    return no(exchangeFailure(e));
  }

  let me;
  try {
    me = await new InstagramClient(accessToken, env.GRAPH_VERSION, "me").getMe();
  } catch (e) {
    return no(exchangeFailure(e));
  }
  if ((me.account_type ?? "").toUpperCase() === "PERSONAL") {
    return no(
      fail(400, "personal_account", "This is a personal Instagram account. Switch it to a Professional account, then connect again."),
    );
  }

  const igUserId = String(me.user_id ?? shortUserId);
  const holder = await getTenantByIgUser(env.DB, igUserId);
  if (holder && holder.tenant_id !== tenant.tenant_id) {
    return no(
      fail(409, "account_connected_elsewhere", "This Instagram account is already connected to another publik account."),
    );
  }

  await saveTenantToken(env, tenant.tenant_id, accessToken, now() + expiresIn);
  await patchTenant(env.DB, tenant.tenant_id, {
    ig_user_id: igUserId,
    username: me.username ?? null,
    account_type: me.account_type ?? null,
    meta_app_id: app.appId,
    status: "active",
    paused_reason: null,
  });
  const fresh = await getTenant(env.DB, tenant.tenant_id);
  return { response: json({ ok: true, tenant: publicView(fresh ?? tenant) }), connected: true };
}

/**
 * Turn an Instagram-side failure into something publik can show. Before the app has Advanced
 * Access, an account with no role on the app gets through the consent screen but every Graph
 * call answers "Unsupported request" / "Insufficient Developer Role" — that is not the creator's
 * mistake, so it gets its own code.
 */
function exchangeFailure(e: unknown): Response {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof InstagramApiError ? e.status : 0;
  if (/unsupported request|insufficient developer role|not been approved|app is not (live|approved)/i.test(msg)) {
    return fail(403, "app_not_approved_for_account", "publik is waiting for Meta approval, so this account cannot connect yet.");
  }
  if (/authorization code|code has (expired|been used)|redirect_uri/i.test(msg)) {
    return fail(400, "code_rejected", "Instagram did not accept the sign-in. Please connect again.");
  }
  console.warn(`[chatmany] OAuth exchange failed (${status}): ${msg.slice(0, 300)}`);
  return fail(502, "instagram_exchange_failed", "Instagram did not complete the connection. Please try again.");
}

/** True for the tenant API calls that change what the runner should be doing. */
export function isTenantApiWrite(subpath: string, method: string): boolean {
  return method === "POST" && subpath.startsWith("/campaigns");
}

/**
 * /hosted/tenants/{id}/api/* — routes/api.ts, one tenant at a time. `subpath` starts with "/".
 */
export async function tenantApi(
  env: HostedEnv,
  tenant: TenantRow,
  subpath: string,
  req: Request,
  url: URL,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const db = new TenantDb(env.DB, tenant.tenant_id);

  if (subpath === "/status" && method === "GET") return await statusResponse(env, tenant);
  if (subpath === "/media" && method === "GET") return await mediaResponse(env, tenant);

  if (subpath === "/campaigns" && method === "GET") {
    const archived = url.searchParams.get("archived") === "1";
    const items = await db.getAllCampaigns({ archived });
    return json({
      campaigns: items.map((i) => ({ ...i.campaign, active: i.active, archived: i.archived, updated_at: i.updated_at })),
    });
  }
  if (subpath === "/campaigns" && method === "POST") {
    const payload = (await safeJson(req)) as { campaign?: unknown; active?: boolean };
    let campaign;
    try {
      campaign = validateCampaign(payload.campaign);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    await db.upsertCampaign(campaign, payload.active ?? true);
    return json({ ok: true, campaign_id: campaign.campaign_id });
  }
  if (subpath === "/campaigns/status" && method === "POST") {
    const body = (await safeJson(req)) as { campaign_id?: string; active?: boolean };
    if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
    await db.setCampaignActive(body.campaign_id, Boolean(body.active));
    return json({ ok: true });
  }
  if (subpath === "/campaigns/archive" && method === "POST") {
    const body = (await safeJson(req)) as { campaign_id?: string; archived?: boolean };
    if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
    await db.setCampaignArchived(body.campaign_id, Boolean(body.archived));
    return json({ ok: true });
  }
  if (subpath === "/campaigns/delete" && method === "POST") {
    const body = (await safeJson(req)) as { campaign_id?: string };
    if (!body.campaign_id) return json({ error: "campaign_id required" }, 400);
    await db.deleteCampaign(body.campaign_id);
    return json({ ok: true });
  }

  if (subpath === "/dashboard" && method === "GET") return await dashboard(db, url);
  if (subpath === "/contacts" && method === "GET") {
    const rows = await db.listConversations(url.searchParams.get("campaign_id"));
    return json({
      contacts: rows.map((r) => ({
        igsid: r.igsid,
        username: r.username,
        campaign_id: r.campaign_id,
        state: r.state,
        status_label: STATE_LABEL[r.state] ?? r.state,
        followed: r.followed === 1,
        email: r.email,
        updated_at: r.updated_at,
      })),
    });
  }
  if (subpath === "/contacts/export" && method === "GET") {
    const rows = await db.listConversations(url.searchParams.get("campaign_id"));
    const header = ["username", "igsid", "campaign_id", "status", "followed", "email", "updated_at"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          csv(r.username ?? ""),
          csv(r.igsid),
          csv(r.campaign_id),
          csv(STATE_LABEL[r.state] ?? r.state),
          r.followed === 1 ? "yes" : "no",
          csv(r.email ?? ""),
          new Date(r.updated_at * 1000).toISOString(),
        ].join(","),
      );
    }
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="chatmany-contacts.csv"`,
      },
    });
  }

  return json({ error: "not found" }, 404);
}

async function clientFor(env: HostedEnv, tenant: TenantRow): Promise<InstagramClient | null> {
  const token = await tenantAccessToken(env, tenant);
  if (!token || !tenant.ig_user_id) return null;
  return new InstagramClient(token, env.GRAPH_VERSION, tenant.ig_user_id);
}

async function statusResponse(env: HostedEnv, tenant: TenantRow): Promise<Response> {
  const client = await clientFor(env, tenant);
  if (!client) return json({ connected: false });
  const expiresAt = tenant.meta_token_expires_at ?? 0;
  // The picture URL is short-lived on Instagram's CDN, so it is read live and never stored. A
  // failure here must not make a connected account look disconnected.
  let picture: string | null = null;
  let username = tenant.username;
  let accountType = tenant.account_type;
  try {
    const me = await client.getMe();
    picture = me.profile_picture_url ?? null;
    username = me.username ?? username;
    accountType = me.account_type ?? accountType;
  } catch {
    // keep the stored values
  }
  return json({
    connected: true,
    username,
    account_type: accountType,
    profile_picture_url: picture,
    ig_user_id: tenant.ig_user_id,
    expires_at: expiresAt,
    expires_in_days: Math.max(0, Math.round((expiresAt - now()) / 86400)),
    token_expired: expiresAt <= now(),
    status: tenant.status,
    paused_reason: tenant.paused_reason,
  });
}

async function mediaResponse(env: HostedEnv, tenant: TenantRow): Promise<Response> {
  const client = await clientFor(env, tenant);
  if (!client) return json({ error: "not connected" }, 400);
  try {
    return json({ media: await client.getMedia(30) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

async function dashboard(db: TenantDb, url: URL): Promise<Response> {
  const campaignId = url.searchParams.get("campaign_id");
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 30));
  const counts = await db.eventCountsByType(campaignId, now() - days * 86400);
  const comments = counts.comment_matched;
  const pct = (n: number) => (comments > 0 ? Math.round((n / comments) * 100) : 0);
  return json({
    campaign_id: campaignId,
    days,
    cards: {
      comments,
      sends: counts.opening_sent,
      clicks: counts.button_clicked,
      ctr: counts.opening_sent > 0 ? Math.round((counts.button_clicked / counts.opening_sent) * 100) : 0,
      follows: counts.follow_confirmed,
      emails: counts.email_captured,
      delivered: counts.delivered,
    },
    funnel: [
      { label: "Commented", value: comments, pct: 100 },
      { label: "Clicked", value: counts.button_clicked, pct: pct(counts.button_clicked) },
      { label: "Followed", value: counts.follow_confirmed, pct: pct(counts.follow_confirmed) },
      { label: "Gave email", value: counts.email_captured, pct: pct(counts.email_captured) },
      { label: "Delivered", value: counts.delivered, pct: pct(counts.delivered) },
    ],
  });
}

const STATE_LABEL: Record<string, string> = {
  NEW: "opening",
  AWAITING_TAP: "opening sent",
  AWAITING_FOLLOW: "awaiting follow",
  AWAITING_EMAIL: "awaiting email",
  DELIVER: "delivering",
  DONE: "delivered",
};

function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
