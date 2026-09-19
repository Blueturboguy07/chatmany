// TenantRunner — everything one hosted creator's work needs, with no reference to any other
// tenant. The Durable Object (src/tenant/do.ts) is a thin wrapper around this class; the logic
// lives here so it can be tested without a workerd runtime.
//
// WHY A DURABLE OBJECT PER TENANT — the whole reason Cloudflare was chosen
// -----------------------------------------------------------------------
// Cloudflare is NOT the cheapest host per event (Vercel Functions on the Supabase publik already
// pays for is roughly half the marginal price). It is the only one of the candidates whose
// isolation primitive is native: one object per tenant, addressed by name, single-threaded.
// Every production failure chatmany has had was an isolation failure:
//
//   * 2026-08-23 `exceededCpu` — the account-wide cron tick ran one D1 query per comment across
//     every active campaign, was killed mid-loop, and left later commenters silently unserved.
//     Here, each tenant's work happens in that tenant's object, under that object's own CPU
//     budget and its own alarm retry. One creator's viral reel cannot kill another's tick.
//   * 2026-09-01 D1 free-tier daily row reads — one unindexed global count took the whole
//     account down for the rest of the UTC day. Here every hot query is tenant-prefixed.
//   * 2026-09-15 the 613 death spiral — `claimPollSlot` was time-based only, so cron runs up to
//     15 minutes long OVERLAPPED, sent concurrently, saturated Instagram's rate limit and were
//     killed at the cron wall clock with locks still held. A Durable Object IS the run lock:
//     there is exactly one runner per tenant, always, and `runExclusive` below keeps it that way
//     within an invocation too.
//
// The cron therefore does no work inline. It fans out to objects, and each object re-arms its
// own alarm.

import type { InstagramClient } from "../api/client";
import { Engine } from "../engine/engine";
import { SendQueue } from "../queue/queue";
import type { NormalizedComment, NormalizedEvent, NormalizedMessage } from "../types";
import { toUnixSeconds } from "../runtime";
import type { TenantDb } from "./db";
import type { MeterStorage, UsageMeter } from "./metering";
import { UNIT_EVENT, UNIT_POLL, UNIT_SEND } from "./metering";

export interface RunnerLimits {
  /** Outbound Graph calls per run. The live build settled on 15-30 after the 613 spiral. */
  maxSendsPerRun: number;
  /** New comments admitted per run, so one viral post yields between runs. */
  maxNewCommentsPerRun: number;
  /** Wall-clock budget per run, well under the Durable Object alarm retry window. */
  runBudgetMs: number;
  /** Cooldown after Instagram answers 613, per tenant. */
  rateLimitCooldownSeconds: number;
  /** Per-tenant opening sends per rolling hour. */
  hourlySendCap: number;
  /** Comment pages walked per media per sweep run. */
  sweepPagesPerRun: number;
  /** Spacing between sends, ms. */
  sendIntervalMs: number;
}

export const DEFAULT_LIMITS: RunnerLimits = {
  maxSendsPerRun: 25,
  maxNewCommentsPerRun: 200,
  runBudgetMs: 4 * 60_000,
  rateLimitCooldownSeconds: 180,
  hourlySendCap: 750,
  sweepPagesPerRun: 8,
  sendIntervalMs: 1200,
};

export interface RunnerDeps {
  tenantId: string;
  db: TenantDb;
  storage: MeterStorage;
  client: InstagramClient;
  meter: UsageMeter;
  /** The connected account's IG user id, so we never answer our own comments. */
  igUserId?: string | null;
  /** Persist a status change on the tenants row (paused_credit, paused_meta, ...). */
  onStatus?: (status: "active" | "paused_credit" | "paused_meta", reason: string | null) => Promise<void>;
  limits?: Partial<RunnerLimits>;
  now?: () => number;
}

export interface RunReport {
  events: number;
  sends: number;
  skipped: "cooldown" | "credit" | null;
  rateLimited: boolean;
}

const K_COOLDOWN = "rate_limited_until";
const K_LAST_SEND = "last_send_at_ms";
const K_PAUSED_CREDIT = "paused_credit";
const K_SWEEP_IDX = "sweep_media_idx";
const K_SWEEP_CURSOR = "sweep_cursor:";

export class TenantRunner {
  private readonly limits: RunnerLimits;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RunnerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Serialize everything this tenant does. A Durable Object delivers one request at a time, but
   * an awaited storage or network call still lets a second request interleave — and two
   * concurrent senders for one account is exactly the overlapping-run 613 spiral. Nothing below
   * runs outside this queue.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ---- entry points ----

  /** Webhook deliveries (the default path). Events are metered whether or not they match. */
  handleEvents(events: NormalizedEvent[]): Promise<RunReport> {
    return this.runExclusive(async () => {
      const report = this.newReport();
      await this.deps.meter.record(UNIT_EVENT, events.length);
      report.events = events.length;
      const guard = await this.guard(report);
      if (guard) return await this.finish(report);

      const ctx = await this.begin(report);
      const campaigns = await this.deps.db.getActiveCampaigns();
      for (const evt of events) {
        if (this.outOfBudget(ctx, report)) break;
        if (evt.kind === "comment") await ctx.engine.handleComment(evt, campaigns);
        else await ctx.engine.handleMessage(evt, campaigns);
      }
      await this.end(ctx);
      return await this.finish(report);
    });
  }

  /** Polling fallback: one tick for this tenant, newest page of each active media. */
  runPoll(): Promise<RunReport> {
    return this.runExclusive(async () => {
      const report = this.newReport();
      await this.deps.meter.record(UNIT_POLL, 1);
      const guard = await this.guard(report);
      if (guard) return await this.finish(report);

      const ctx = await this.begin(report);
      const campaigns = await this.deps.db.getActiveCampaigns();
      const media = [...new Set(campaigns.map((c) => c.media_id))];
      for (const mediaId of media) {
        if (this.outOfBudget(ctx, report)) break;
        const page = await this.safeGetComments(mediaId, 50);
        if (!page) continue;
        await this.ingestComments(ctx, report, page.comments, campaigns);
      }
      await this.pollMessages(ctx, report, campaigns);
      await this.end(ctx);
      return await this.finish(report);
    });
  }

  /**
   * Backlog sweep: walk one media's comment pages from a stored cursor, rotating media between
   * runs. The newest-100 read window is why ~1,850 ghost-reel comments were never seen at all —
   * a comment that scrolls out of the window before its retry is lost unless something walks the
   * history.
   */
  runSweep(): Promise<RunReport> {
    return this.runExclusive(async () => {
      const report = this.newReport();
      const guard = await this.guard(report);
      if (guard) return await this.finish(report);

      const ctx = await this.begin(report);
      const campaigns = await this.deps.db.getActiveCampaigns();
      const media = [...new Set(campaigns.map((c) => c.media_id))];
      if (media.length > 0) {
        const idx = ((await this.deps.storage.get<number>(K_SWEEP_IDX)) ?? 0) % media.length;
        const mediaId = media[idx]!;
        let cursor = await this.deps.storage.get<string>(K_SWEEP_CURSOR + mediaId);
        for (let page = 0; page < this.limits.sweepPagesPerRun; page++) {
          if (this.outOfBudget(ctx, report)) break;
          const res = await this.safeGetComments(mediaId, 50, cursor);
          if (!res) break;
          await this.deps.meter.record(UNIT_POLL, 1);
          await this.ingestComments(ctx, report, res.comments, campaigns);
          if (!res.next) {
            cursor = undefined; // end of history: start again from the newest next time round
            break;
          }
          cursor = res.next;
        }
        await this.deps.storage.put(K_SWEEP_CURSOR + mediaId, cursor ?? "");
        await this.deps.storage.put(K_SWEEP_IDX, idx + 1);
      }
      await this.end(ctx);
      return await this.finish(report);
    });
  }

  /** Flush metered units without doing any Instagram work (the usage alarm). */
  flushUsage(force = false): Promise<void> {
    return this.runExclusive(async () => {
      const res = await this.deps.meter.flush(force);
      await this.applyCredit(res.insufficientCredit);
    });
  }

  /** Is this tenant currently stopped for want of credit? */
  async isPausedForCredit(): Promise<boolean> {
    return (await this.deps.storage.get<boolean>(K_PAUSED_CREDIT)) === true;
  }

  async cooldownUntil(): Promise<number> {
    return (await this.deps.storage.get<number>(K_COOLDOWN)) ?? 0;
  }

  // ---- internals ----

  private newReport(): RunReport {
    return { events: 0, sends: 0, skipped: null, rateLimited: false };
  }

  /** Returns true when this run must not send anything. */
  private async guard(report: RunReport): Promise<boolean> {
    if (this.now() < (await this.cooldownUntil())) {
      report.skipped = "cooldown";
      return true;
    }
    if (await this.isPausedForCredit()) {
      // Events keep being ingested and stored; only the sending stops, so a top-up resumes the
      // backlog in order rather than losing it.
      report.skipped = "credit";
      return true;
    }
    return false;
  }

  private async begin(report: RunReport): Promise<RunContext> {
    const startedAt = Date.now();
    const lastSendAt = (await this.deps.storage.get<number>(K_LAST_SEND)) ?? 0;
    const sentThisHour = await this.deps.db.countEventsForTenant("opening_sent", this.now() - 3600);
    const queue = new SendQueue({
      minIntervalMs: this.limits.sendIntervalMs,
      initialLastSendAt: lastSendAt,
    });
    const ctx: RunContext = { startedAt, queue, newComments: 0, hourRemaining: Math.max(0, this.limits.hourlySendCap - sentThisHour), engine: null as unknown as Engine };
    ctx.engine = new Engine(this.deps.db, this.deps.client, queue, {
      onSendAttempt: () => {
        report.sends++;
        void this.deps.meter.record(UNIT_SEND, 1);
      },
      onRateLimit: () => {
        report.rateLimited = true;
      },
      sendsExhausted: () =>
        report.sends >= this.limits.maxSendsPerRun ||
        report.sends >= ctx.hourRemaining ||
        Date.now() - ctx.startedAt > this.limits.runBudgetMs,
    });
    return ctx;
  }

  private async end(ctx: RunContext): Promise<void> {
    if (ctx.queue.lastSendAtMs > 0) await this.deps.storage.put(K_LAST_SEND, ctx.queue.lastSendAtMs);
  }

  private outOfBudget(ctx: RunContext, report: RunReport): boolean {
    if (report.rateLimited) return true; // stop the moment Instagram says back off
    if (Date.now() - ctx.startedAt > this.limits.runBudgetMs) return true;
    return ctx.newComments >= this.limits.maxNewCommentsPerRun;
  }

  private async finish(report: RunReport): Promise<RunReport> {
    if (report.rateLimited) {
      await this.deps.storage.put(K_COOLDOWN, this.now() + this.limits.rateLimitCooldownSeconds);
    }
    const res = await this.deps.meter.flush();
    await this.applyCredit(res.insufficientCredit);
    return report;
  }

  private async applyCredit(insufficient: boolean): Promise<void> {
    const paused = await this.isPausedForCredit();
    if (insufficient && !paused) {
      await this.deps.storage.put(K_PAUSED_CREDIT, true);
      await this.deps.onStatus?.("paused_credit", "Hosting paused — add a pack to resume");
    } else if (!insufficient && paused) {
      await this.deps.storage.put(K_PAUSED_CREDIT, false);
      await this.deps.onStatus?.("active", null);
    }
  }

  /**
   * Admit a page of comments: ONE batched processed-comment lookup, then the engine. The batched
   * lookup is the `exceededCpu` fix — the old path made a D1 round trip per comment.
   */
  private async ingestComments(
    ctx: RunContext,
    report: RunReport,
    comments: Array<{ id: string; text?: string; timestamp?: string; username?: string; from?: { id: string; username?: string } }>,
    campaigns: Awaited<ReturnType<TenantDb["getActiveCampaigns"]>>,
  ): Promise<void> {
    const fresh = comments.filter((c) => c.id && c.from?.id && c.from.id !== this.deps.igUserId);
    if (fresh.length === 0) return;
    const seen = await this.deps.db.processedCommentIds(fresh.map((c) => c.id));
    for (const c of fresh) {
      if (this.outOfBudget(ctx, report)) return;
      if (seen.has(c.id)) continue;
      ctx.newComments++;
      report.events++;
      await this.deps.meter.record(UNIT_EVENT, 1);
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: c.id,
        igsid: c.from!.id,
        username: c.from?.username ?? c.username,
        text: c.text ?? "",
        media_id: (c as { media_id?: string }).media_id ?? "",
        timestamp: toUnixSeconds(c.timestamp),
      };
      await ctx.engine.handleComment(evt, campaigns);
    }
  }

  private async pollMessages(
    ctx: RunContext,
    report: RunReport,
    campaigns: Awaited<ReturnType<TenantDb["getActiveCampaigns"]>>,
  ): Promise<void> {
    if (this.outOfBudget(ctx, report)) return;
    let conversations;
    try {
      conversations = await this.deps.client.getConversations(20);
    } catch (e) {
      console.warn(`[chatmany] ${this.deps.tenantId}: conversation read failed (${msg(e)})`);
      return;
    }
    for (const convo of conversations) {
      for (const m of convo.messages?.data ?? []) {
        if (this.outOfBudget(ctx, report)) return;
        const from = m.from?.id;
        if (!from || from === this.deps.igUserId) continue;
        report.events++;
        await this.deps.meter.record(UNIT_EVENT, 1);
        const evt: NormalizedMessage = {
          kind: "message",
          igsid: from,
          text: m.message,
          timestamp: toUnixSeconds(m.created_time),
        };
        await ctx.engine.handleMessage(evt, campaigns);
      }
    }
  }

  private async safeGetComments(
    mediaId: string,
    limit: number,
    after?: string,
  ): Promise<{ comments: Array<{ id: string; text?: string; timestamp?: string; username?: string; from?: { id: string; username?: string } }>; next?: string } | null> {
    try {
      const page = await this.deps.client.getCommentsPage(mediaId, limit, after);
      return { comments: page.comments.map((c) => ({ ...c, media_id: mediaId })), next: page.next };
    } catch (e) {
      console.warn(`[chatmany] ${this.deps.tenantId}: comment read failed for ${mediaId} (${msg(e)})`);
      return null;
    }
  }
}

interface RunContext {
  startedAt: number;
  queue: SendQueue;
  engine: Engine;
  newComments: number;
  hourRemaining: number;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
