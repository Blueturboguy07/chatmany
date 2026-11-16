// Billing on the Worker side: publik's wallet decides whether a hosted tenant may send.
//
//   - an empty publik wallet sends no reply, from the very first poll (the balance gate);
//   - a top-up resumes replies on publik's next "can pay" answer;
//   - publik being unreachable never stops a creator's replies, and never resumes a paused one;
//   - a paused tenant is not charged for polls it did not make, and nobody is charged for comments
//     too old to answer.

import { beforeEach, describe, expect, it } from "vitest";
import { BalanceGate, EMPTY_RECHECK_SECONDS, OK_RECHECK_SECONDS } from "../src/tenant/balance";
import { TenantDb } from "../src/tenant/db";
import { UNIT_EVENT, UNIT_POLL, UsageMeter } from "../src/tenant/metering";
import { TenantRunner } from "../src/tenant/runner";
import type { Campaign } from "../src/types";
import { FakeClient } from "./helpers/fakeClient";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeStorage } from "./helpers/fakeStorage";

const USER = "7c1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";

/** A fake publik: the balance answer and the usage answer, both switchable mid-test. */
class FakePublik {
  canPay: boolean | "down" = true;
  paused = false;
  balanceCalls: string[] = [];
  usage: Array<{ tenant: string; units: Array<{ slug: string; units: number }> }> = [];

  fetcher = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/v1/infra/balance") {
      this.balanceCalls.push(u.searchParams.get("tenant") ?? "");
      if (this.canPay === "down") throw new Error("network down");
      return new Response(JSON.stringify({ tenant: u.searchParams.get("tenant"), can_pay: this.canPay }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { batches: Array<{ tenant: string; idempotency_key: string; units: Array<{ slug: string; units: number }> }> };
    const b = body.batches[0]!;
    this.usage.push({ tenant: b.tenant, units: b.units });
    return new Response(JSON.stringify({ results: [{ idempotency_key: b.idempotency_key, settled: true, paused: this.paused }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    media_id: "media-1",
    keywords: ["link"],
    deliver_in_opening: true,
    reward: { type: "link", value: "https://example.com/guide" },
    copy: { opening: "Here you go", delivery: "Here is the link: {reward}" },
    ...over,
  } as Campaign;
}

function harness(opts: { comments?: number; now?: () => number; ageSeconds?: number } = {}) {
  const d1 = makeTestDb();
  const db = new TenantDb(d1, "t_bill");
  const storage = new FakeStorage();
  const client = new FakeClient();
  const publik = new FakePublik();
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const common = { publikUserId: USER, storage, endpoint: "https://publikhq.test", token: "ingest", fetcher: publik.fetcher, now: clock };
  const meter = new UsageMeter({ tenantId: "t_bill", db, ...common });
  const balance = new BalanceGate(common);
  const age = opts.ageSeconds ?? 0;
  client.seedComments("media-1", [
    Array.from({ length: opts.comments ?? 2 }, (_, i) => ({ id: `c${i}`, text: "link please", igsid: `u${i}` })),
  ]);
  if (age > 0) {
    for (const page of client.pages["media-1"] ?? []) for (const c of page) c.timestamp = new Date(Date.now() - age * 1000).toISOString();
  }
  const statuses: string[] = [];
  const runner = new TenantRunner({
    tenantId: "t_bill",
    db,
    storage,
    client: client.asClient(),
    meter,
    balance,
    igUserId: "owner",
    limits: { sendIntervalMs: 0 },
    now: clock,
    onStatus: async (status) => {
      statuses.push(status);
    },
  });
  return { db, storage, client, publik, meter, balance, runner, statuses };
}

describe("the balance gate", () => {
  let now = 1_800_000_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_800_000_000;
  });

  it("asks publik by the owning user's id and caches the answer", async () => {
    const h = harness({ now: clock });
    expect(await h.balance.check()).toBe("ok");
    expect(await h.balance.check()).toBe("ok");
    expect(h.publik.balanceCalls).toEqual([USER]);
    now += OK_RECHECK_SECONDS;
    await h.balance.check();
    expect(h.publik.balanceCalls).toHaveLength(2);
  });

  it("re-asks within a minute while the wallet is empty, so a top-up resumes quickly", async () => {
    const h = harness({ now: clock });
    h.publik.canPay = false;
    expect(await h.balance.check()).toBe("empty");
    h.publik.canPay = true;
    now += EMPTY_RECHECK_SECONDS - 1;
    expect(await h.balance.check()).toBe("empty");
    now += 1;
    expect(await h.balance.check()).toBe("ok");
  });

  it("keeps the last known answer when publik is unreachable, and never invents an empty wallet", async () => {
    const h = harness({ now: clock });
    h.publik.canPay = "down";
    expect(await h.balance.check()).toBe("ok");
    h.publik.canPay = false;
    expect(await h.balance.check()).toBe("empty");
    h.publik.canPay = "down";
    now += EMPTY_RECHECK_SECONDS;
    expect(await h.balance.check()).toBe("empty");
  });

  it("never pauses anything when billing is not configured", async () => {
    const storage = new FakeStorage();
    const gate = new BalanceGate({ publikUserId: USER, storage, endpoint: "", token: "ingest" });
    expect(gate.configured()).toBe(false);
    expect(await gate.check()).toBe("ok");
  });
});

describe("an empty publik wallet sends no reply", () => {
  it("from the first poll, and is charged for nothing it did not do", async () => {
    const h = harness();
    h.publik.canPay = false;
    await h.db.upsertCampaign(campaign(), true);

    const report = await h.runner.runPoll();
    expect(report.skipped).toBe("credit");
    expect(h.client.calls.privateReplyText).toHaveLength(0);
    expect(h.statuses).toEqual(["paused_credit"]);
    await h.runner.flushUsage(true);
    expect(h.publik.usage).toEqual([]);
  });

  it("resumes on publik's next 'can pay' answer after a top-up", async () => {
    // Real time: the seeded comments are stamped now, and comments past 7 days are not read.
    let now = Math.floor(Date.now() / 1000);
    const h = harness({ now: () => now });
    h.publik.canPay = false;
    await h.db.upsertCampaign(campaign(), true);
    await h.runner.runPoll();
    expect(h.client.calls.privateReplyText).toHaveLength(0);

    h.publik.canPay = true;
    now += EMPTY_RECHECK_SECONDS;
    const after = await h.runner.runPoll();
    expect(after.sends).toBe(2);
    expect(h.statuses).toEqual(["paused_credit", "active"]);
  });

  it("pauses when a usage flush says the wallet just ran out", async () => {
    const h = harness();
    await h.db.upsertCampaign(campaign(), true);
    h.publik.paused = true;
    await h.runner.runPoll();
    await h.runner.flushUsage(true);
    expect(await h.runner.isPausedForCredit()).toBe(true);
    // The flush answer is also the gate's freshest word, so the next run does not send.
    h.client.seedComments("media-1", [[{ id: "c9", text: "link", igsid: "u9" }]]);
    const next = await h.runner.runPoll();
    expect(next.skipped).toBe("credit");
  });

  it("a flush with nothing to report does not resume a paused tenant", async () => {
    let now = Math.floor(Date.now() / 1000);
    const h = harness({ now: () => now });
    h.publik.canPay = false;
    await h.db.upsertCampaign(campaign(), true);
    await h.runner.runPoll();
    h.publik.canPay = "down";
    now += EMPTY_RECHECK_SECONDS;
    await h.runner.flushUsage(true);
    expect(await h.runner.isPausedForCredit()).toBe(true);
    expect((await h.runner.runPoll()).skipped).toBe("credit");
  });

  it("publik being down does not stop a tenant that was never told its wallet is empty", async () => {
    const h = harness();
    h.publik.canPay = "down";
    await h.db.upsertCampaign(campaign(), true);
    expect((await h.runner.runPoll()).sends).toBe(2);
  });
});

describe("what is metered", () => {
  it("reports a poll and the comments to publik under the owning user", async () => {
    const h = harness();
    await h.db.upsertCampaign(campaign(), true);
    await h.runner.runPoll();
    await h.runner.flushUsage(true);
    expect(h.publik.usage).toHaveLength(1);
    expect(h.publik.usage[0]!.tenant).toBe(USER);
    const units = Object.fromEntries(h.publik.usage[0]!.units.map((u) => [u.slug, u.units]));
    expect(units[UNIT_POLL]).toBe(1);
    expect(units[UNIT_EVENT]).toBe(2);
  });

  it("does not read or charge for comments older than Instagram's 7-day reply window", async () => {
    const h = harness({ ageSeconds: 8 * 86400 });
    await h.db.upsertCampaign(campaign(), true);
    const report = await h.runner.runPoll();
    expect(report.events).toBe(0);
    expect(h.client.calls.privateReplyText).toHaveLength(0);
    await h.runner.flushUsage(true);
    const units = Object.fromEntries((h.publik.usage[0]?.units ?? []).map((u) => [u.slug, u.units]));
    expect(units[UNIT_EVENT]).toBeUndefined();
  });
});
