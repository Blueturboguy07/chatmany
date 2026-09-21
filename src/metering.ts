/**
 * Per-tenant usage metering, flushed to publik API.
 *
 * publik runs this worker for a creator and charges what it costs publik plus 10%
 * (pricing epoch 3, migration 0042 in the publik repo). The three unit classes are fixed by
 * that price sheet and this file must not invent a fourth:
 *
 *   chatmany.event  one inbound comment or message processed for this tenant
 *   chatmany.send   one outbound Graph call attempted, ANY outcome
 *   chatmany.poll   one polling tick, fallback mode only
 *
 * `chatmany.send` counts attempts rather than successes on purpose. publik pays for the
 * request the moment it leaves, and a creator whose sends are failing is still costing money
 * — billing only for successes would hide exactly the situation somebody needs to look at.
 *
 * WHY A RETRY IS FREE, AND WHY THAT IS LOAD-BEARING HERE
 * -----------------------------------------------------
 * This worker already learned, expensively, that an unknown outcome must never be treated as
 * "did not happen": a Meta 500 on a private reply still DELIVERED, and retrying produced 142
 * duplicate DMs (see schema/0003_send_claims.sql). The same trap points at money here. If a
 * flush times out we do not know whether publik recorded it, so every flush carries an
 * idempotency key and the server replays the recorded total instead of charging twice. The
 * key is derived from the tenant and the window, never random, so a retry after a cold start
 * produces the same key the first attempt used.
 *
 * Nothing in here can refuse to serve a creator. Metering is a record of work already done;
 * if publik is unreachable the counts stay buffered and the DMs keep going out. The only
 * thing the server can ask for is a PAUSE, and that is a decision for the caller to act on,
 * not something this module enforces mid-send.
 */

export const INFRA_UNIT_SLUGS = ["chatmany.event", "chatmany.send", "chatmany.poll"] as const;
export type InfraUnitSlug = (typeof INFRA_UNIT_SLUGS)[number];

export type UnitCounts = Partial<Record<InfraUnitSlug, number>>;

export interface FlushResult {
  /** False when nothing was owed or no key is configured — not an error. */
  sent: boolean;
  /** True when publik says this wallet is empty and the tenant should stop. */
  paused: boolean;
  /** Micro-dollars charged, as publik recorded them. Null when nothing was sent. */
  chargeMicros: number | null;
  /** Set when the flush failed. The counts stay buffered; this is not fatal. */
  error?: string;
}

/**
 * The idempotency key for one tenant's flush of one window.
 *
 * Derived, never random: a retry after the worker restarted has to produce the same key the
 * first attempt used, or publik charges the same work twice. The window is the unit of
 * "same flush" — two different windows are genuinely different work.
 */
export function flushKey(tenantId: string, windowId: string): string {
  return `${tenantId}:${windowId}`;
}

/** Drops zero and negative counts: a unit class with nothing in it is not a line. */
export function billableUnits(counts: UnitCounts): Array<{ slug: InfraUnitSlug; units: number }> {
  const out: Array<{ slug: InfraUnitSlug; units: number }> = [];
  for (const slug of INFRA_UNIT_SLUGS) {
    const n = counts[slug];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      out.push({ slug, units: Math.floor(n) });
    }
  }
  return out;
}

export interface FlushOptions {
  /** publikhq.com, or a base URL for tests. */
  baseUrl: string;
  /** The shared ingest token. This endpoint is not a pk_ key route — a creator must not be able to write their own bill. */
  ingestToken: string;
  tenantId: string;
  /** The tenant's pk_live_ key. Null for a self-hosted install: nothing is billed and nothing is sent. */
  publikKey: string | null;
  windowId: string;
  counts: UnitCounts;
  fetchImpl?: typeof fetch;
}

export async function flushUsage(opts: FlushOptions): Promise<FlushResult> {
  const units = billableUnits(opts.counts);
  if (units.length === 0) return { sent: false, paused: false, chargeMicros: null };
  // A self-hosted install runs on the creator's own Cloudflare account and their own Meta
  // app. publik is not paying for any of it, so there is nothing to bill and no key to bill
  // it to. Silently skipping is the correct behaviour, not a degraded one.
  if (!opts.publikKey) return { sent: false, paused: false, chargeMicros: null };

  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    batches: [
      {
        tenant: opts.publikKey,
        idempotency_key: flushKey(opts.tenantId, opts.windowId),
        units,
      },
    ],
  };

  try {
    const res = await doFetch(`${opts.baseUrl}/api/v1/infra/usage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.ingestToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { sent: false, paused: false, chargeMicros: null, error: `publik returned ${res.status}` };
    }
    const json = (await res.json()) as {
      results?: Array<{ charge_micros?: number; paused?: boolean }>;
    };
    const first = json.results?.[0];
    return {
      sent: true,
      paused: first?.paused === true,
      chargeMicros: typeof first?.charge_micros === "number" ? first.charge_micros : null,
    };
  } catch (err) {
    // Buffered, not lost. The caller keeps the counts and tries the same key next tick.
    return {
      sent: false,
      paused: false,
      chargeMicros: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
