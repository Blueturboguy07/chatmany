// Metering: batches, idempotency, retry-never-drop, and the 402 that pauses sends.
//
// Note what is NOT here: any price. The Worker counts units; publik prices them from its real
// Cloudflare bill (see the header of src/tenant/metering.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { TenantDb } from "../src/tenant/db";
import { FLUSH_UNITS, UNIT_EVENT, UNIT_SEND, UsageMeter } from "../src/tenant/metering";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeStorage } from "./helpers/fakeStorage";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { tenant_id: string; publik_user_id: string | null; idempotency_key: string; units: Array<{ slug: string; count: number; at: number }> };
}

function makeMeter(opts: { status?: () => number; throwOnce?: boolean } = {}) {
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
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response("{}", { status: opts.status ? opts.status() : 200 });
  }) as unknown as typeof fetch;
  const meter = new UsageMeter({
    tenantId: "t_one",
    publikUserId: "u_1",
    storage,
    db,
    endpoint: "https://publikhq.test/",
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
    expect(call.headers["idempotency-key"]).toBe(call.body.idempotency_key);
    expect(call.body.tenant_id).toBe("t_one");
    expect(call.body.publik_user_id).toBe("u_1");
    expect(Object.fromEntries(call.body.units.map((u) => [u.slug, u.count]))).toEqual({
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
    expect(h.calls[0]!.body.idempotency_key).not.toBe(h.calls[1]!.body.idempotency_key);
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
    expect(failing.calls[0]!.body.units[0]!.count).toBe(3);
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
    expect(flaky.calls[0]!.body.idempotency_key).toBe(flaky.calls[1]!.body.idempotency_key);
  });

  it("treats a 409 (already recorded) as delivered", async () => {
    const dup = makeMeter({ status: () => 409 });
    await dup.meter.record(UNIT_SEND, 1);
    expect((await dup.meter.flush(true)).delivered).toBe(1);
  });
});

describe("402 insufficient credit", () => {
  it("reports it up so the runner can pause sends, and keeps the batch for the retry", async () => {
    const broke = makeMeter({ status: () => 402 });
    await broke.meter.record(UNIT_SEND, 1);
    const res = await broke.meter.flush(true);
    expect(res.insufficientCredit).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.queued).toBe(1);
  });
});
