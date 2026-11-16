// Metering: batches, idempotency, retry-never-drop, publik's per-batch answer, and the pause.
//
// Note what is NOT here: any price. The Worker counts units; publik prices them from its real
// Cloudflare bill (see the header of src/tenant/metering.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { TenantDb } from "../src/tenant/db";
import { FLUSH_UNITS, MAX_BATCHES_PER_FLUSH, UNIT_EVENT, UNIT_SEND, UsageMeter, readResult, wireKey } from "../src/tenant/metering";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeStorage } from "./helpers/fakeStorage";

/** The body publik parses (lib/publik-api/infra/units.ts in the publik repo). */
interface WireBatch {
  tenant: string;
  idempotency_key: string;
  units: Array<{ slug: string; units: number }>;
}
interface Call {
  url: string;
  headers: Record<string, string>;
  body: { batches: WireBatch[] };
  /** The one batch this meter sends per request. */
  batch: WireBatch;
}

type Answer = (batch: WireBatch) => { status: number; body?: unknown };

/** publik's 200: one result per batch, settled, with the wallet's pause flag. */
const settled =
  (paused = false): Answer =>
  (b) => ({ status: 200, body: { results: [{ idempotency_key: b.idempotency_key, settled: true, replayed: false, paused }] } });

function makeMeter(opts: { status?: () => number; throwOnce?: boolean; answer?: Answer; publikUserId?: string | null; endpoint?: string } = {}) {
  const d1 = makeTestDb();
  const db = new TenantDb(d1, "t_one");
  const storage = new FakeStorage();
  const calls: Call[] = [];
  let shouldThrow = opts.throwOnce ?? false;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error("network down");
    }
    const body = JSON.parse(String(init.body)) as { batches: WireBatch[] };
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body, batch: body.batches[0]! });
    const status = opts.status ? opts.status() : 200;
    const out = status === 200 ? (opts.answer ?? settled())(body.batches[0]!) : { status, body: {} };
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
  }) as unknown as typeof fetch;
  const meter = new UsageMeter({
    tenantId: "t_one",
    publikUserId: opts.publikUserId === undefined ? "7c1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6" : opts.publikUserId,
    storage,
    db,
    endpoint: opts.endpoint ?? "https://publikhq.test/",
    token: "ingest-token",
    fetcher,
  });
  return { meter, db, storage, calls };
}

let h: ReturnType<typeof makeMeter>;
beforeEach(() => {
  h = makeMeter();
});

describe("batching", () => {
  it("does not POST a handful of units before either threshold trips", async () => {
    await h.meter.record(UNIT_EVENT, 3);
    const res = await h.meter.flush();
    expect(res.delivered).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it("POSTs one batch carrying every slug once the unit threshold trips", async () => {
    await h.meter.record(UNIT_EVENT, FLUSH_UNITS);
    await h.meter.record(UNIT_SEND, 7);
    const res = await h.meter.flush();

    expect(res.delivered).toBe(1);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe("https://publikhq.test/api/v1/infra/usage");
    expect(call.headers.authorization).toBe("Bearer ingest-token");
    expect(call.headers["idempotency-key"]).toBe(call.batch.idempotency_key);
    // publik bills the owning publik user's wallet, so the batch names that user.
    expect(call.body.batches).toHaveLength(1);
    expect(call.batch.tenant).toBe("7c1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6");
    expect(call.batch.idempotency_key).toMatch(/^[A-Za-z0-9_.-]{8,128}$/);
    expect(Object.fromEntries(call.batch.units.map((u) => [u.slug, u.units]))).toEqual({
      [UNIT_EVENT]: FLUSH_UNITS,
      [UNIT_SEND]: 7,
    });
  });

  it("gives every batch its own idempotency key", async () => {
    await h.meter.record(UNIT_SEND, 1);
    await h.meter.flush(true);
    await h.meter.record(UNIT_SEND, 1);
    await h.meter.flush(true);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.batch.idempotency_key).not.toBe(h.calls[1]!.batch.idempotency_key);
  });

  it("writes the D1 ledger: units when a batch forms, reported when publik acknowledges", async () => {
    await h.meter.record(UNIT_SEND, 5);
    await h.meter.flush(true);
    const rows = await h.db.usageForMonth();
    expect(rows).toEqual([expect.objectContaining({ slug: UNIT_SEND, units: 5, reported: 5 })]);
  });
});

describe("a reporting failure never drops the count", () => {
  it("keeps the batch queued when publik is unreachable, and delivers it on the next flush", async () => {
    const failing = makeMeter({ throwOnce: true });
    await failing.meter.record(UNIT_SEND, 3);
    const first = await failing.meter.flush(true);
    expect(first.delivered).toBe(0);
    expect(first.queued).toBe(1);
    expect(failing.calls).toHaveLength(0);

    // The units are already in D1, marked unreported: units - reported is what is in flight.
    const mid = await failing.db.usageForMonth();
    expect(mid[0]).toMatchObject({ units: 3, reported: 0 });

    const second = await failing.meter.flush(true);
    expect(second.delivered).toBe(1);
    expect(second.queued).toBe(0);
    expect(failing.calls[0]!.batch.units[0]!.units).toBe(3);
    expect((await failing.db.usageForMonth())[0]).toMatchObject({ units: 3, reported: 3 });
  });

  it("retries a 500 from publik with the SAME idempotency key, so nothing is billed twice", async () => {
    let status = 500;
    const flaky = makeMeter({ status: () => status });
    await flaky.meter.record(UNIT_SEND, 2);
    expect((await flaky.meter.flush(true)).delivered).toBe(0);
    status = 200;
    expect((await flaky.meter.flush(true)).delivered).toBe(1);
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[0]!.batch.idempotency_key).toBe(flaky.calls[1]!.batch.idempotency_key);
  });

  it("treats a 409 (already recorded) as delivered", async () => {
    const dup = makeMeter({ status: () => 409 });
    await dup.meter.record(UNIT_SEND, 1);
    expect((await dup.meter.flush(true)).delivered).toBe(1);
  });
});

describe("what publik says about the wallet", () => {
  it("passes publik's pause up when the settled batch emptied the wallet", async () => {
    const broke = makeMeter({ answer: settled(true) });
    await broke.meter.record(UNIT_SEND, 1);
    const res = await broke.meter.flush(true);
    // The usage itself is recorded: publik already paid for that send.
    expect(res).toMatchObject({ delivered: 1, queued: 0, credit: "empty", insufficientCredit: true });
  });

  it("says ok when the wallet can still pay", async () => {
    await h.meter.record(UNIT_SEND, 1);
    expect(await h.meter.flush(true)).toMatchObject({ delivered: 1, credit: "ok", insufficientCredit: false });
  });

  it("says nothing when there was nothing to report, so a flush cannot resume a paused tenant", async () => {
    expect(await h.meter.flush(true)).toMatchObject({ delivered: 0, credit: null });
  });

  it("says nothing when publik could not be reached", async () => {
    const failing = makeMeter({ throwOnce: true });
    await failing.meter.record(UNIT_SEND, 1);
    expect(await failing.meter.flush(true)).toMatchObject({ delivered: 0, queued: 1, credit: null });
  });

  it("still understands an older publik's 402, and keeps the batch for the retry", async () => {
    const broke = makeMeter({ status: () => 402 });
    await broke.meter.record(UNIT_SEND, 1);
    const res = await broke.meter.flush(true);
    expect(res).toMatchObject({ delivered: 0, queued: 1, credit: "empty", insufficientCredit: true });
  });
});

describe("batches publik refuses", () => {
  it("keeps a batch publik cannot bill yet (no wallet key for the user) and retries it", async () => {
    const answer: Answer = (b) => ({ status: 200, body: { results: [{ idempotency_key: b.idempotency_key, settled: false, error: { type: "invalid_tenant", message: "No live publik key for this tenant." } }] } });
    const m = makeMeter({ answer });
    await m.meter.record(UNIT_SEND, 1);
    expect(await m.meter.flush(true)).toMatchObject({ delivered: 0, queued: 1, credit: null });
  });

  it("drops a batch publik will never accept, so it cannot block every later batch", async () => {
    const m = makeMeter({ status: () => 400 });
    await m.meter.record(UNIT_SEND, 1);
    expect(await m.meter.flush(true)).toMatchObject({ delivered: 0, queued: 0 });
    // The count is not lost: it stays in D1 as units not reported.
    expect((await m.db.usageForMonth())[0]).toMatchObject({ units: 1, reported: 0 });
  });

  it("retries an answer that names no result for the batch", async () => {
    const m = makeMeter({ answer: () => ({ status: 200, body: { results: [] } }) });
    await m.meter.record(UNIT_SEND, 1);
    expect(await m.meter.flush(true)).toMatchObject({ delivered: 0, queued: 1 });
  });

  it("reads publik's per-batch answer", () => {
    expect(readResult({ results: [{ idempotency_key: "k.123456", settled: true, paused: false }] }, "k.123456")).toEqual({ kind: "accepted", credit: "ok" });
    expect(readResult({ results: [{ idempotency_key: "k.123456", settled: true, paused: true }] }, "k.123456")).toEqual({ kind: "accepted", credit: "empty" });
    expect(readResult({ results: [{ idempotency_key: "k.123456", settled: false, error: { type: "invalid_field" } }] }, "k.123456")).toEqual({ kind: "rejected" });
    expect(readResult({ results: [{ idempotency_key: "other.key", settled: true }] }, "k.123456")).toEqual({ kind: "retry" });
    expect(readResult(null, "k.123456")).toEqual({ kind: "retry" });
  });
});

describe("when usage cannot reach publik at all", () => {
  it("counts in D1 and posts nothing when the tenant has no publik owner", async () => {
    const m = makeMeter({ publikUserId: null });
    await m.meter.record(UNIT_SEND, 2);
    expect(await m.meter.flush(true)).toMatchObject({ delivered: 0, queued: 1, credit: null });
    expect(m.calls).toHaveLength(0);
    expect((await m.db.usageForMonth())[0]).toMatchObject({ units: 2, reported: 0 });
  });

  it("posts nothing when the publik address is not configured", async () => {
    const m = makeMeter({ endpoint: "" });
    await m.meter.record(UNIT_SEND, 2);
    await m.meter.flush(true);
    expect(m.calls).toHaveLength(0);
  });

  it("drains a long backlog a few batches per flush", async () => {
    const ok = makeMeter();
    // Queue more batches than one flush delivers (roll() is what a flush does before delivering).
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH + 5; i++) {
      await ok.meter.record(UNIT_SEND, 1);
      await (ok.meter as unknown as { roll(): Promise<void> }).roll();
    }
    const first = await ok.meter.flush();
    expect(first.delivered).toBe(MAX_BATCHES_PER_FLUSH);
    expect(first.queued).toBe(5);
    expect((await ok.meter.flush()).queued).toBe(0);
  });
});

describe("idempotency keys on the wire", () => {
  it("are what publik accepts, including keys an older build queued with colons", () => {
    expect(wireKey("t_9f2c:1758240000:ab12cd")).toBe("t_9f2c.1758240000.ab12cd");
    expect(wireKey("t_9f2c:1758240000:ab12cd")).toBe(wireKey("t_9f2c:1758240000:ab12cd"));
    expect(wireKey("ab")).toMatch(/^[A-Za-z0-9_.-]{8,128}$/);
    expect(wireKey("x".repeat(300))).toHaveLength(128);
  });
});
