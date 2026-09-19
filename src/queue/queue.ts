// Send queue with throttling + exponential backoff (Section 10). Workers are stateless between
// invocations, so this serializes and paces the sends within a single cron tick and retries on
// 429 / rate-limit errors. Cross-invocation hourly caps are enforced separately in the poller
// via the events table. Network waits don't count against the 10ms CPU budget.

import { InstagramApiError } from "../api/client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface QueueOptions {
  /** Minimum spacing between sends, ms. Paces us well under ~200 DMs/hr. */
  minIntervalMs?: number;
  /** Max retries on rate-limit errors before giving up on that send. */
  maxRetries?: number;
  /** Base backoff, ms (doubles each retry). */
  baseBackoffMs?: number;
  /**
   * Epoch ms of the previous send, carried over from an earlier invocation. A hosted tenant's
   * Durable Object persists it, so pacing survives across runs instead of restarting at zero and
   * firing a burst the moment a new run begins.
   */
  initialLastSendAt?: number;
}

export class SendQueue {
  private lastSendAt = 0;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(opts: QueueOptions = {}) {
    this.lastSendAt = opts.initialLastSendAt ?? 0;
    this.minIntervalMs = opts.minIntervalMs ?? 1200;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
  }

  /** Epoch ms of the last send attempt, for the caller to persist between invocations. */
  get lastSendAtMs(): number {
    return this.lastSendAt;
  }

  /**
   * Run a send with pacing + backoff. Throws if it still fails after retries, or on any
   * non-rate-limit error (so the caller can decide whether to leave state unchanged).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Pace: ensure at least minIntervalMs since the previous send.
    const since = Date.now() - this.lastSendAt;
    if (since < this.minIntervalMs) await sleep(this.minIntervalMs - since);

    let attempt = 0;
    for (;;) {
      try {
        const result = await fn();
        this.lastSendAt = Date.now();
        return result;
      } catch (e) {
        const isRate = e instanceof InstagramApiError && e.isRateLimit;
        if (!isRate || attempt >= this.maxRetries) {
          this.lastSendAt = Date.now();
          throw e;
        }
        const backoff = this.baseBackoffMs * 2 ** attempt;
        console.warn(`[chatmany] rate-limited, backing off ${backoff}ms (attempt ${attempt + 1})`);
        await sleep(backoff);
        attempt++;
      }
    }
  }
}
