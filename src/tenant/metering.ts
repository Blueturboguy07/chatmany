// Per-tenant usage metering.
//
// WHAT IS METERED, AND WHY IT IS ONLY EVER A COUNT
// -----------------------------------------------
// Three billable classes, counted by the tenant's own Durable Object as it does the work:
//   chatmany.event — one inbound comment or message processed
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
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: MeterOptions) {
    this.fetcher = opts.fetcher ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Count units. Never throws and never blocks the work being metered. */
  async record(slug: string, count = 1): Promise<void> {
    if (count <= 0) return;
    const p = await this.loadPending();
    p.counts[slug] = (p.counts[slug] ?? 0) + count;
    if (p.since === 0) p.since = this.now();
    await this.opts.storage.put(PENDING_KEY, p);
  }

  /** True when the pending counts have reached either flush threshold. */
  async due(): Promise<boolean> {
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
    if (force || (await this.due())) await this.roll();
    return await this.deliver();
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
    const batch: UsageBatch = {
      idempotency_key: wireKey(`${this.opts.tenantId}.${at}.${randomToken(6)}`),
      units: entries.map(([slug, count]) => ({ slug, count, at })),
    };
    for (const [slug, count] of entries) await this.opts.db.addUsage(slug, count);

    const queue = await this.loadQueue();
    queue.push(batch);
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
    if (!this.reportable()) return { delivered, queued: queue.length, credit, insufficientCredit: false };

    let attempts = 0;
    while (queue.length > 0 && attempts < MAX_BATCHES_PER_FLUSH) {
      attempts++;
      const batch = queue[0]!;
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
      if (res.status === 402) return { kind: "insufficient_credit" };
      // A duplicate idempotency key is already recorded: treat it as delivered.
      if (res.status === 409) return { kind: "accepted", credit: null };
      if (res.status === 400) return { kind: "rejected" };
      if (!res.ok) {
        console.warn(`[chatmany] usage ingest ${res.status} for ${this.opts.tenantId}; will retry`);
        return { kind: "retry" };
      }
      return readResult(await res.json().catch(() => null), key);
    } catch (e) {
      console.warn(
        `[chatmany] usage ingest unreachable for ${this.opts.tenantId} (${e instanceof Error ? e.message : String(e)}); will retry`,
      );
      return { kind: "retry" };
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
