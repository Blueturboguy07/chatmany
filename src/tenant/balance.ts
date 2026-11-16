// Can this tenant's publik wallet still pay? Asked before any Instagram work that can send.
//
// WHY A CHECK BEFORE SENDING, AND NOT ONLY THE FLUSH ANSWER
// ---------------------------------------------------------
// publik bills hosted chatmany to the creator's publik wallet (usage flushes, metering.ts). A
// flush answer says whether the wallet can still pay, but it only arrives after units were spent,
// and a tenant with an empty wallet from the start has no units to flush. So the runner asks
// publik first:
//
//   GET {PUBLIK_API_BASE}/api/v1/infra/balance?tenant=<publik user id>
//   Authorization: Bearer <INFRA_INGEST_TOKEN>
//   200 {"tenant": "...", "can_pay": true|false}
//
// The answer is cached in the tenant's own Durable Object storage: re-asked after a minute while
// the wallet is empty (so a top-up resumes replies within about a minute), and after ten minutes
// while it can pay (the flush answers every minute keep it fresh in between).
//
// FAIL OPEN ON SILENCE, NEVER ON A "NO". Only publik's own answer pauses or resumes. No answer
// (publik unreachable, a 5xx, billing not configured on either side) keeps the last known state,
// and a tenant never checked is treated as able to pay. A creator's DMs must not stop because
// publik's API had a bad minute; an empty wallet must stop them.

import { globalFetch } from "./metering";
import type { MeterStorage } from "./metering";

export type BalanceState = "ok" | "empty";

/** Re-ask this soon while the wallet is empty, so a top-up resumes replies quickly. */
export const EMPTY_RECHECK_SECONDS = 60;
/** Re-ask this soon while the wallet can pay. Flush answers (every minute of use) refresh it too. */
export const OK_RECHECK_SECONDS = 10 * 60;

const K_STATE = "balance:state";
const K_CHECKED_AT = "balance:checked_at";

export interface BalanceOptions {
  publikUserId: string | null;
  storage: MeterStorage;
  endpoint: string | undefined;
  token: string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class BalanceGate {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: BalanceOptions) {
    // Never the bare global: workerd refuses a fetch called as a method (see globalFetch).
    this.fetcher = opts.fetcher ?? globalFetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** True when the gate can ask publik at all. Without it, nothing is ever paused here. */
  configured(): boolean {
    return Boolean(this.opts.endpoint && this.opts.token && this.opts.publikUserId);
  }

  /** The last state publik gave, or null when it never answered. */
  async last(): Promise<BalanceState | null> {
    return (await this.opts.storage.get<BalanceState>(K_STATE)) ?? null;
  }

  /** Record what publik said (from this check or from a usage flush answer). */
  async remember(state: BalanceState): Promise<void> {
    await this.opts.storage.put(K_STATE, state);
    await this.opts.storage.put(K_CHECKED_AT, this.now());
  }

  /**
   * The wallet state to act on: publik's answer when it is fresh or when publik answers now, else
   * the last known state, else "ok" (never checked and publik silent: do not stop the creator).
   */
  async check(): Promise<BalanceState> {
    if (!this.configured()) return "ok";
    const last = await this.last();
    const checkedAt = (await this.opts.storage.get<number>(K_CHECKED_AT)) ?? 0;
    const maxAge = last === "empty" ? EMPTY_RECHECK_SECONDS : OK_RECHECK_SECONDS;
    if (last !== null && this.now() - checkedAt < maxAge) return last;

    const answer = await this.ask();
    if (answer === null) return last ?? "ok";
    await this.remember(answer);
    return answer;
  }

  private async ask(): Promise<BalanceState | null> {
    const url = new URL(`${String(this.opts.endpoint).replace(/\/+$/, "")}/api/v1/infra/balance`);
    url.searchParams.set("tenant", String(this.opts.publikUserId));
    try {
      const res = await this.fetcher(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/json",
          "user-agent": "publik-chatmany-hosted/1.0",
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.warn(`[chatmany] balance check answered ${res.status}; keeping the last known state`);
        return null;
      }
      const body = (await res.json().catch(() => null)) as { can_pay?: unknown } | null;
      if (!body || typeof body.can_pay !== "boolean") return null;
      return body.can_pay ? "ok" : "empty";
    } catch (e) {
      console.warn(`[chatmany] balance check unreachable (${e instanceof Error ? e.message : String(e)}); keeping the last known state`);
      return null;
    }
  }
}
