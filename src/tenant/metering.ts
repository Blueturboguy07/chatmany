// Per-tenant usage metering.
//
// WHAT IS METERED, AND WHY IT IS ONLY EVER A COUNT
// -----------------------------------------------
// Three billable classes, counted by the tenant's own Durable Object as it does the work:
//   chatmany.event — one inbound comment or message, counted once ever (the runner checks the
//                    metered_events ledger, schema 0007, before it records one)
//   chatmany.send  — one outbound Graph call ATTEMPTED (any outcome: a refused private reply
//                    still cost the round trip; the dashboard shows refusals separately)
//   chatmany.poll  — one polling tick for this tenant (fallback mode only)
// Cloudflare's own meters are per script and per database, never per tenant, so first-party
// counting is the only possible source.
//
// This file contains NO PRICE. publik prices each unit class (publik_infra_rates x the price
// sheet's factor, publik migrations 0034/0042/0116) and draws the charge from the owning user's
// publik wallet. The Worker only counts, reports, and stops sending when publik says the wallet
// cannot pay (see balance.ts).
//
// The count is also durable in D1 (usage_monthly): `units` is written when a batch is formed and
// `reported` when publik acknowledges it, so `units - reported` is what is still in flight, and
// SUM(units) GROUP BY slug, month across tenants is the denominator of the rate above.

import type { TenantDb } from "./db";
import { randomToken } from "./crypto";

export const UNIT_EVENT = "chatmany.event";
export const UNIT_SEND = "chatmany.send";
export const UNIT_POLL = "chatmany.poll";

/**
 * Units that stay in D1 (usage_monthly) and never go to publik. A poll is publik's own cost, not a
 * thing the creator pays for, and one poll every 15 seconds made one report every minute for every
 * creator: about 43,000 calls to publik each month for each creator. A report now goes out only
 * when there is a comment, a message or a DM to report.
 */
export const LOCAL_ONLY_UNITS: ReadonlySet<string> = new Set([UNIT_POLL]);

/** Flush when either threshold trips, so a flush is never a single unit. */
export const FLUSH_UNITS = 100;
export const FLUSH_SECONDS = 60;

/**
 * Cap on undelivered batches (~8 hours of a 60s cadence). Past it the OLDEST batch is dropped
 * from the send queue — its units stay in D1 as `units - reported`, so the shortfall is visible
 * to the operator rather than silently invented or double-counted.
 */
export const MAX_QUEUED_BATCHES = 500;

/** One durable batch in the DO's queue. `count` stays the stored name; the wire calls it `units`. */
export interface UsageBatch {
  idempotency_key: string;
  units: Array<{ slug: string; count: number; at: number }>;
}

/** The slice of DurableObjectStorage the meter needs (so it is testable without workerd). */
export interface MeterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface MeterOptions {
  tenantId: string;
  /** The publik user who owns this tenant. publik bills usage to that user's wallet. */
  publikUserId: string | null;
  storage: MeterStorage;
  db: TenantDb;
  /** publik API base, e.g. https://publikhq.com. Empty: usage is counted in D1 and not reported. */
  endpoint: string | undefined;
  token: string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
}

/**
 * What publik said about this tenant's wallet on the last answer it gave.
 *   "ok"    publik settled the batch and the wallet can still pay
 *   "empty" the wallet cannot pay any more: sends pause
 *   null    no answer this time (nothing to report, publik unreachable, not configured)
 * A null never changes the pause: only publik's own answer pauses or resumes sends.
 */
export type CreditState = "ok" | "empty" | null;

export interface FlushResult {
  delivered: number;
  queued: number;
  credit: CreditState;
  /** Kept for callers that only ask "pause?": true exactly when credit is "empty". */
  insufficientCredit: boolean;
}

const PENDING_KEY = "usage:pending";
const QUEUE_KEY = "usage:queue";
const ROLLED_AT_KEY = "usage:rolledAt";
const VERSION_KEY = "usage:version";
const DIAG_KEY = "usage:diag";

/**
 * What the last report attempt and the one-time upgrade did, kept in the tenant's own storage so
 * the operator can read it (GET /hosted/tenants/:id/meter). Secret-free: statuses, times, error
 * text. Added 2026-11-16 because `wrangler tail` shows nothing from a Durable Object.
 */
export interface MeterDiag {
  last_attempt_at: number | null;
  last_status: number | null;
  last_outcome: string | null;
  last_error: string | null;
  last_ok_at: number | null;
  upgrade_at: number | null;
  upgrade_dropped: number | null;
  upgrade_rows: number | null;
  upgrade_error: string | null;
}

const EMPTY_DIAG: MeterDiag = {
  last_attempt_at: null,
  last_status: null,
  last_outcome: null,
  last_error: null,
  last_ok_at: null,
  upgrade_at: null,
  upgrade_dropped: null,
  upgrade_rows: null,
  upgrade_error: null,
};

/** The meter's stored state, for the operator's diagnostic route. Reads only. */
export async function readMeterState(storage: MeterStorage): Promise<Record<string, unknown>> {
  const queue = (await storage.get<UsageBatch[]>(QUEUE_KEY)) ?? [];
  const totals: Record<string, number> = {};
  for (const b of queue) for (const u of b.units) totals[u.slug] = (totals[u.slug] ?? 0) + u.count;
  return {
    version: (await storage.get<number>(VERSION_KEY)) ?? 1,
    pending: (await storage.get<Pending>(PENDING_KEY)) ?? null,
    queue_length: queue.length,
    queue_totals: totals,
    queue_head: queue.slice(0, 3).map((b) => ({ key: wireKey(b.idempotency_key), units: b.units.map((u) => ({ slug: u.slug, count: u.count })) })),
    rolled_at: (await storage.get<number>(ROLLED_AT_KEY)) ?? null,
    diag: { ...EMPTY_DIAG, ...((await storage.get<MeterDiag>(DIAG_KEY)) ?? {}) },
  };
}

function errorText(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
}

/**
 * Version of what this meter's stored counts mean.
 *   1  (implicit) chatmany.event was counted on every read of a comment or DM, so one DM was
 *      counted again on every 15-second poll while it stayed in the newest 20 conversations.
 *   2  each comment or DM is counted once, ever (the metered_events ledger, schema 0007).
 * Units counted under 1 were never reported (see globalFetch) and are not charged: the first run
 * of version 2 drops them (upgrade below).
 */
export const METER_VERSION = 2;

/**
 * The runtime's fetch, called as a plain function.
 *
 * Storing the global `fetch` on an object and calling it as `this.fetcher(...)` throws
 * "TypeError: Illegal invocation: function called with incorrect `this` reference" in workerd
 * (Node does not care, so the unit tests passed). That is why no usage flush and no balance
 * check ever reached publik from the deployed Worker: every call threw before a byte was sent,
 * was caught as "unreachable", and was retried forever.
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** Batches delivered per flush, so a long outage drains over a few alarms, not one burst. */
export const MAX_BATCHES_PER_FLUSH = 20;

/** publik's rule for an idempotency key (lib/publik-api/infra/units.ts): 8 to 128 of [A-Za-z0-9_.-]. */
const KEY_CHARS = /[^A-Za-z0-9_.-]/g;

/** A batch key publik accepts. Deterministic, so a retry of an older queued batch keeps its key. */
export function wireKey(key: string): string {
  const clean = key.replace(KEY_CHARS, ".").slice(0, 128);
  return clean.length >= 8 ? clean : clean.padEnd(8, ".");
}

interface Pending {
  counts: Record<string, number>;
  since: number;
}

type PostOutcome =
  | { kind: "accepted"; credit: CreditState }
  | { kind: "insufficient_credit" }
  | { kind: "rejected" }
  | { kind: "retry" };

export class UsageMeter {
  private pending: Pending | null = null;
  private queue: UsageBatch[] | null = null;
  private upgraded: Promise<void> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: MeterOptions) {
    this.fetcher = opts.fetcher ?? globalFetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Count units. Never throws and never blocks the work being metered. */
  async record(slug: string, count = 1): Promise<void> {
    if (count <= 0) return;
    await this.ready();
    const p = await this.loadPending();
    p.counts[slug] = (p.counts[slug] ?? 0) + count;
    if (p.since === 0) p.since = this.now();
    await this.opts.storage.put(PENDING_KEY, p);
  }

  /** True when the pending counts have reached either flush threshold. */
  async due(): Promise<boolean> {
    await this.ready();
    const p = await this.loadPending();
    const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
    if (total === 0) return (await this.loadQueue()).length > 0;
    return total >= FLUSH_UNITS || this.now() - p.since >= FLUSH_SECONDS;
  }

  /**
   * Roll pending counts into a batch and try to deliver everything queued.
   *
   * Reporting failures never touch the user's work: the batch stays queued and is retried on the
   * next alarm. The DM that was already sent has been sent.
   */
  async flush(force = false): Promise<FlushResult> {
    await this.ready();
    if (force || (await this.due())) await this.roll();
    return await this.deliver();
  }

  /** Run the one-time upgrade (below) before this meter reads or writes any count. */
  private ready(): Promise<void> {
    this.upgraded ??= this.upgrade().catch(async (e) => {
      // Never block the tenant's work on the upgrade: note it; the next object tries again.
      console.error(`[chatmany] ${this.opts.tenantId}: meter upgrade failed (${errorText(e)})`);
      await this.note({ upgrade_at: this.now(), upgrade_error: errorText(e) }).catch(() => undefined);
    });
    return this.upgraded;
  }

  /** Merge into the stored diagnostics (readMeterState). */
  private async note(patch: Partial<MeterDiag>): Promise<void> {
    const cur = (await this.opts.storage.get<MeterDiag>(DIAG_KEY)) ?? EMPTY_DIAG;
    await this.opts.storage.put(DIAG_KEY, { ...EMPTY_DIAG, ...cur, ...patch });
  }

  /**
   * Version 1 counts of chatmany.event are wrong (one DM counted on every poll) and were never
   * reported, so they are dropped, once: from the pending counts, from every queued batch, and
   * from D1 (`units` back to `reported` for that slug). Poll and send counts were right; they stay
   * queued, summed into one backlog batch. Nothing of version 1 ever reached publik (every report
   * threw before it was sent, and publik holds no chatmany usage row), so no batch here was
   * settled before and none is settled twice.
   *
   * It runs before this meter records anything, and only the tenant's own object writes its
   * usage rows, so the D1 correction cannot remove a version 2 count.
   */
  private async upgrade(): Promise<void> {
    const storage = this.opts.storage;
    if (((await storage.get<number>(VERSION_KEY)) ?? 1) >= METER_VERSION) return;

    let dropped = 0;
    const pending = await this.loadPending();
    if (pending.counts[UNIT_EVENT]) {
      dropped += pending.counts[UNIT_EVENT]!;
      delete pending.counts[UNIT_EVENT];
      if (!Object.values(pending.counts).some((n) => n > 0)) pending.since = 0;
      await storage.put(PENDING_KEY, pending);
    }
    // What is left of the old queue goes to publik as ONE batch, not one request per minute of
    // backlog. That is safe only because no old batch was ever settled (see the note above).
    const counts: Record<string, number> = {};
    let lastAt = 0;
    for (const batch of await this.loadQueue()) {
      for (const u of batch.units) {
        if (u.slug === UNIT_EVENT) {
          dropped += u.count;
          continue;
        }
        counts[u.slug] = (counts[u.slug] ?? 0) + u.count;
        lastAt = Math.max(lastAt, u.at);
      }
    }
    const kept: UsageBatch[] = Object.values(counts).some((n) => n > 0)
      ? [
          {
            idempotency_key: wireKey(`${this.opts.tenantId}.meter-v${METER_VERSION}.backlog`),
            units: Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([slug, count]) => ({ slug, count, at: lastAt })),
          },
        ]
      : [];
    this.queue = kept;
    await storage.put(QUEUE_KEY, kept);
    await storage.put(VERSION_KEY, METER_VERSION);
    // The queue is what gets charged, and it is already right. The D1 row is the operator's view;
    // a failure here is logged and never stops the tenant's work.
    let rows = 0;
    let rowsError: string | null = null;
    try {
      rows = await this.opts.db.forgiveUnreportedUsage(UNIT_EVENT);
    } catch (e) {
      rowsError = errorText(e);
      console.warn(`[chatmany] ${this.opts.tenantId}: could not reset the old ${UNIT_EVENT} count in D1 (${rowsError})`);
    }
    await this.note({ upgrade_at: this.now(), upgrade_dropped: dropped, upgrade_rows: rows, upgrade_error: rowsError });
    if (dropped > 0 || rows > 0) {
      console.warn(
        `[chatmany] ${this.opts.tenantId}: meter v${METER_VERSION} dropped ${dropped} queued ${UNIT_EVENT} units counted under the old rule (never reported, not charged); ${rows} month row(s) reset to the reported count`,
      );
    }
  }

  /** True when this tenant's usage can reach publik at all. */
  private reportable(): boolean {
    return Boolean(this.opts.endpoint && this.opts.token && this.opts.publikUserId);
  }

  /** Move pending counts into a durable batch and into D1's monthly ledger. */
  private async roll(): Promise<void> {
    const p = await this.loadPending();
    const entries = Object.entries(p.counts).filter(([, n]) => n > 0);
    if (entries.length === 0) return;
    const at = this.now();
    for (const [slug, count] of entries) await this.opts.db.addUsage(slug, count);
    const wire = entries.filter(([slug]) => !LOCAL_ONLY_UNITS.has(slug));

    const queue = await this.loadQueue();
    if (wire.length > 0) {
      queue.push({
        idempotency_key: wireKey(`${this.opts.tenantId}.${at}.${randomToken(6)}`),
        units: wire.map(([slug, count]) => ({ slug, count, at })),
      });
    }
    while (queue.length > MAX_QUEUED_BATCHES) {
      const dropped = queue.shift();
      console.warn(
        `[chatmany] usage backlog over ${MAX_QUEUED_BATCHES} batches for ${this.opts.tenantId}; dropped ${dropped?.idempotency_key} from the send queue (its units stay unreported in D1)`,
      );
    }
    this.pending = { counts: {}, since: 0 };
    await this.opts.storage.put(PENDING_KEY, this.pending);
    await this.opts.storage.put(QUEUE_KEY, queue);
    await this.opts.storage.put(ROLLED_AT_KEY, at);
  }

  private async deliver(): Promise<FlushResult> {
    const queue = await this.loadQueue();
    let delivered = 0;
    let credit: CreditState = null;
    // Not configured, or a tenant with no publik owner: count in D1, report nothing, pause nothing.
    if (!this.reportable()) {
      await this.note({
        last_outcome: "not_configured",
        last_error: `missing:${this.opts.endpoint ? "" : " endpoint"}${this.opts.token ? "" : " token"}${this.opts.publikUserId ? "" : " publik_user_id"}`,
      });
      return { delivered, queued: queue.length, credit, insufficientCredit: false };
    }

    let attempts = 0;
    while (queue.length > 0 && attempts < MAX_BATCHES_PER_FLUSH) {
      const batch = queue[0]!;
      // A batch queued by an older build can still hold poll units: they are not reported.
      batch.units = batch.units.filter((u) => !LOCAL_ONLY_UNITS.has(u.slug));
      if (batch.units.length === 0) {
        queue.shift();
        continue;
      }
      attempts++;
      const outcome = await this.post(batch);
      if (outcome.kind === "accepted") {
        queue.shift();
        delivered++;
        for (const u of batch.units) await this.opts.db.markUsageReported(u.slug, u.count);
        // The newest answer wins: a later batch reflects the wallet after the earlier ones.
        if (outcome.credit !== null) credit = outcome.credit;
        continue;
      }
      if (outcome.kind === "rejected") {
        // publik will never accept this batch (it failed validation). Retrying it forever would
        // block every later batch, so it leaves the send queue; its units stay unreported in D1.
        const dropped = queue.shift();
        console.warn(`[chatmany] usage batch ${dropped?.idempotency_key} for ${this.opts.tenantId} was refused by publik; dropped (units stay unreported in D1)`);
        continue;
      }
      if (outcome.kind === "insufficient_credit") {
        // An older publik answered 402 for an empty wallet: keep the batch (the idempotency key
        // makes the retry safe) and pause sends.
        credit = "empty";
        break;
      }
      break; // transport or server error: stop, keep the queue, retry on the next alarm
    }

    await this.opts.storage.put(QUEUE_KEY, queue);
    return { delivered, queued: queue.length, credit, insufficientCredit: credit === "empty" };
  }

  /**
   * One batch to POST /api/v1/infra/usage, in the body publik parses
   * (lib/publik-api/infra/units.ts): `{batches: [{tenant, idempotency_key, units: [{slug, units}]}]}`.
   * `tenant` is the owning publik user's id; publik bills that user's wallet.
   */
  private async post(batch: UsageBatch): Promise<PostOutcome> {
    const at = this.now();
    const result = await this.postOnce(batch);
    await this.note({
      last_attempt_at: at,
      last_status: result.status,
      last_outcome: result.outcome.kind,
      last_error: result.error,
      ...(result.outcome.kind === "accepted" ? { last_ok_at: at } : {}),
    });
    return result.outcome;
  }

  private async postOnce(batch: UsageBatch): Promise<{ outcome: PostOutcome; status: number | null; error: string | null }> {
    const url = `${String(this.opts.endpoint).replace(/\/+$/, "")}/api/v1/infra/usage`;
    const key = wireKey(batch.idempotency_key);
    try {
      const res = await this.fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
          "idempotency-key": key,
          "user-agent": "publik-chatmany-hosted/1.0",
        },
        body: JSON.stringify({
          batches: [
            {
              tenant: this.opts.publikUserId,
              idempotency_key: key,
              units: batch.units.map((u) => ({ slug: u.slug, units: u.count })),
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const status = res.status;
      if (status === 402) return { outcome: { kind: "insufficient_credit" }, status, error: null };
      // A duplicate idempotency key is already recorded: treat it as delivered.
      if (status === 409) return { outcome: { kind: "accepted", credit: null }, status, error: null };
      if (status === 400) return { outcome: { kind: "rejected" }, status, error: (await res.text().catch(() => "")).slice(0, 300) };
      if (!res.ok) {
        console.warn(`[chatmany] usage ingest ${status} for ${this.opts.tenantId}; will retry`);
        return { outcome: { kind: "retry" }, status, error: (await res.text().catch(() => "")).slice(0, 300) };
      }
      const body = await res.json().catch(() => null);
      const outcome = readResult(body, key);
      return { outcome, status, error: outcome.kind === "accepted" ? null : JSON.stringify(body).slice(0, 300) };
    } catch (e) {
      console.warn(`[chatmany] usage ingest unreachable for ${this.opts.tenantId} (${errorText(e)}); will retry`);
      return { outcome: { kind: "retry" }, status: null, error: errorText(e) };
    }
  }

  private async loadPending(): Promise<Pending> {
    if (!this.pending) {
      this.pending = (await this.opts.storage.get<Pending>(PENDING_KEY)) ?? { counts: {}, since: 0 };
    }
    return this.pending;
  }

  private async loadQueue(): Promise<UsageBatch[]> {
    if (!this.queue) this.queue = (await this.opts.storage.get<UsageBatch[]>(QUEUE_KEY)) ?? [];
    return this.queue;
  }
}

/**
 * publik's answer for one batch: `{results: [{idempotency_key, settled, paused, error?}]}`.
 *   settled + paused     recorded; the wallet cannot pay any more ("empty")
 *   settled, not paused  recorded; the wallet can still pay ("ok")
 *   invalid_tenant       publik has no wallet key for this user yet: keep the batch and retry
 *   any other refusal    the batch itself is bad: it leaves the queue
 * An answer that names no result for this key is treated as a server error and retried.
 */
export function readResult(body: unknown, key: string): PostOutcome {
  const results = body && typeof body === "object" ? (body as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return { kind: "retry" };
  const mine = results.find(
    (r): r is Record<string, unknown> => !!r && typeof r === "object" && (r as Record<string, unknown>).idempotency_key === key,
  );
  if (!mine) return { kind: "retry" };
  if (mine.settled === true) return { kind: "accepted", credit: mine.paused === true ? "empty" : "ok" };
  const error = mine.error && typeof mine.error === "object" ? (mine.error as Record<string, unknown>).type : undefined;
  if (error === "invalid_tenant") return { kind: "retry" };
  return { kind: "rejected" };
}
