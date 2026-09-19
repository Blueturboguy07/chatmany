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
// This file contains NO PRICE. The creator is charged from publik's REAL Cloudflare invoice:
// while publik's marginal cost for a class is zero (inside the included quotas) the creator pays
// zero for it, and once publik's bill for that class is non-zero the rate for that month is
// (real marginal monthly cost / total metered units that month) x 1.03. Rates therefore change
// every month, default to zero, and are set by an operator job publik-side from the invoice.
// Hard-coding a Cloudflare list price here would silently invent a charge, so nothing here
// converts a unit into money.
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
  publikUserId: string | null;
  storage: MeterStorage;
  db: TenantDb;
  /** publik API base, e.g. https://publikhq.com */
  endpoint: string;
  token: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface FlushResult {
  delivered: number;
  queued: number;
  /** publik answered 402: the wallet is empty. Sends pause; events keep being ingested. */
  insufficientCredit: boolean;
}

const PENDING_KEY = "usage:pending";
const QUEUE_KEY = "usage:queue";
const ROLLED_AT_KEY = "usage:rolledAt";

interface Pending {
  counts: Record<string, number>;
  since: number;
}

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

  /** Move pending counts into a durable batch and into D1's monthly ledger. */
  private async roll(): Promise<void> {
    const p = await this.loadPending();
    const entries = Object.entries(p.counts).filter(([, n]) => n > 0);
    if (entries.length === 0) return;
    const at = this.now();
    const batch: UsageBatch = {
      idempotency_key: `${this.opts.tenantId}:${at}:${randomToken(6)}`,
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
    let insufficientCredit = false;

    while (queue.length > 0) {
      const batch = queue[0]!;
      const outcome = await this.post(batch);
      if (outcome === "accepted") {
        queue.shift();
        delivered++;
        for (const u of batch.units) await this.opts.db.markUsageReported(u.slug, u.count);
        continue;
      }
      if (outcome === "insufficient_credit") {
        // publik recorded nothing to charge against: keep the batch (the idempotency key makes
        // the retry safe) and tell the caller to pause sends.
        insufficientCredit = true;
        break;
      }
      break; // transport or server error: stop, keep the queue, retry on the next alarm
    }

    await this.opts.storage.put(QUEUE_KEY, queue);
    return { delivered, queued: queue.length, insufficientCredit };
  }

  private async post(batch: UsageBatch): Promise<"accepted" | "insufficient_credit" | "retry"> {
    const url = `${this.opts.endpoint.replace(/\/+$/, "")}/api/v1/infra/usage`;
    try {
      const res = await this.fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
          "idempotency-key": batch.idempotency_key,
        },
        body: JSON.stringify({
          tenant_id: this.opts.tenantId,
          publik_user_id: this.opts.publikUserId,
          idempotency_key: batch.idempotency_key,
          units: batch.units,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 402) return "insufficient_credit";
      if (res.ok) return "accepted";
      // A duplicate idempotency key is already recorded — treat it as delivered.
      if (res.status === 409) return "accepted";
      console.warn(`[chatmany] usage ingest ${res.status} for ${this.opts.tenantId}; will retry`);
      return "retry";
    } catch (e) {
      console.warn(
        `[chatmany] usage ingest unreachable for ${this.opts.tenantId} (${e instanceof Error ? e.message : String(e)}); will retry`,
      );
      return "retry";
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
