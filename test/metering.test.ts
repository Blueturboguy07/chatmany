import { describe, expect, it, vi } from "vitest";
import { billableUnits, flushKey, flushUsage, INFRA_UNIT_SLUGS } from "../src/metering";

/**
 * The money path for the pooled deployment. Two rules are worth breaking a build over,
 * and both are the same lesson this worker already paid for once with 142 duplicate DMs:
 * an unknown outcome is not "did not happen", and a retry must be free.
 */

const BASE = "https://publikhq.com";
const TOKEN = "ingest_test";

function ok(payload: unknown) {
  // Args declared so the assertions below can read what was actually sent.
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(payload), { status: 200 })
  );
}

describe("what gets billed", () => {
  it("bills only the three classes the price sheet defines", () => {
    expect([...INFRA_UNIT_SLUGS]).toEqual(["chatmany.event", "chatmany.send", "chatmany.poll"]);
  });

  it("drops empty classes rather than sending a zero line", () => {
    expect(billableUnits({ "chatmany.event": 0, "chatmany.send": 4 })).toEqual([
      { slug: "chatmany.send", units: 4 },
    ]);
    expect(billableUnits({})).toEqual([]);
  });

  it("refuses a fractional count, because a third of a DM is not a thing", () => {
    expect(billableUnits({ "chatmany.send": 2.7 })).toEqual([{ slug: "chatmany.send", units: 2 }]);
  });
});

describe("a retry is free", () => {
  it("derives the key from tenant and window, never randomly", () => {
    // If this were random, a flush retried after a cold start would be charged twice.
    expect(flushKey("t-1", "2026-09-21T18")).toBe(flushKey("t-1", "2026-09-21T18"));
    expect(flushKey("t-1", "2026-09-21T18")).not.toBe(flushKey("t-2", "2026-09-21T18"));
    expect(flushKey("t-1", "2026-09-21T18")).not.toBe(flushKey("t-1", "2026-09-21T19"));
  });

  it("sends that key on the wire", async () => {
    const fetchImpl = ok({ results: [{ charge_micros: 110_000, paused: false }] });
    await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "t-1",
      publikKey: "pk_live_abc",
      windowId: "w-9",
      counts: { "chatmany.send": 5_000 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    expect(body.batches[0].idempotency_key).toBe("t-1:w-9");
    expect(body.batches[0].units).toEqual([{ slug: "chatmany.send", units: 5_000 }]);
  });
});

describe("nothing here can stop a creator being served", () => {
  it("reports a failed flush without throwing, so the DMs keep going out", async () => {
    const res = await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "t-1",
      publikKey: "pk_live_abc",
      windowId: "w-9",
      counts: { "chatmany.event": 10 },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(res.error).toContain("offline");
    expect(res.paused).toBe(false);
  });

  it("treats a non-200 the same way — buffered, not lost", async () => {
    const res = await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "t-1",
      publikKey: "pk_live_abc",
      windowId: "w-9",
      counts: { "chatmany.event": 10 },
      fetchImpl: (vi.fn(async () => new Response("nope", { status: 503 }))) as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(res.error).toContain("503");
  });

  it("passes a pause back to the caller to act on, rather than enforcing it here", async () => {
    const res = await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "t-1",
      publikKey: "pk_live_abc",
      windowId: "w-9",
      counts: { "chatmany.send": 2_000 },
      fetchImpl: ok({ results: [{ charge_micros: 2_200_000, paused: true }] }) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ sent: true, paused: true, chargeMicros: 2_200_000 });
  });
});

describe("a self-hosted install is not billed", () => {
  it("sends nothing at all when the tenant has no publik key", async () => {
    const fetchImpl = ok({});
    const res = await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "solo",
      publikKey: null,
      windowId: "w-9",
      counts: { "chatmany.event": 900, "chatmany.send": 400 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ sent: false, paused: false, chargeMicros: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing when there is nothing to bill, key or not", async () => {
    const fetchImpl = ok({});
    const res = await flushUsage({
      baseUrl: BASE,
      ingestToken: TOKEN,
      tenantId: "t-1",
      publikKey: "pk_live_abc",
      windowId: "w-9",
      counts: { "chatmany.poll": 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
