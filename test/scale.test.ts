// Scale rules added 2026-11-16: post rotation, the idle flag, the start time of an automation,
// and the reading of Instagram's rate-limit header.
import { beforeEach, describe, expect, it } from "vitest";
import { TenantRunner, usagePercent } from "../src/tenant/runner";
import { TenantDb } from "../src/tenant/db";
import { UsageMeter } from "../src/tenant/metering";
import type { Campaign } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";
import { FakeStorage } from "./helpers/fakeStorage";

function campaign(over: Partial<Campaign> & { campaign_id: string; media_id: string }): Campaign {
  return {
    name: over.campaign_id,
    keywords: ["link"],
    exclude: [],
    deliver_in_opening: true,
    reward: { type: "link", value: "https://publikhq.com/x" },
    copy: { opening: "tap", delivery: "here you go {reward}" },
    ...over,
  };
}

let db: TenantDb;
let client: FakeClient;
let storage: FakeStorage;
let runner: TenantRunner;
let reads: string[];

beforeEach(() => {
  db = new TenantDb(makeTestDb(), "t_scale");
  client = new FakeClient();
  storage = new FakeStorage();
  reads = [];
  const real = client.getCommentsPage.bind(client);
  client.getCommentsPage = async (mediaId: string, limit = 50, after?: string) => {
    reads.push(mediaId);
    return real(mediaId, limit, after);
  };
  runner = new TenantRunner({
    tenantId: "t_scale",
    db,
    storage,
    client: client.asClient(),
    meter: new UsageMeter({ tenantId: "t_scale", publikUserId: null, storage, db, endpoint: "", token: "" }),
    igUserId: "owner",
    limits: { sendIntervalMs: 0, pollAllMediaUpTo: 2, coldMediaPerPoll: 2, maxHotMediaPerPoll: 3 },
  });
});

describe("which posts a poll reads", () => {
  it("reads every post while there are few", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "a", media_id: "m1" }));
    await db.upsertCampaign(campaign({ campaign_id: "b", media_id: "m2" }));
    await runner.runPoll();
    expect(reads.sort()).toEqual(["m1", "m2"]);
  });

  it("takes many posts in turn, and reads a post with a new comment on every poll", async () => {
    for (let i = 1; i <= 6; i++) await db.upsertCampaign(campaign({ campaign_id: `c${i}`, media_id: `m${i}` }));
    client.seedComments("m5", [[{ id: "k1", text: "link", igsid: "p1" }]]);
    const seen = new Set<string>();
    for (let poll = 0; poll < 3; poll++) {
      reads = [];
      await runner.runPoll();
      expect(reads.length).toBeLessThanOrEqual(3);
      reads.forEach((m) => seen.add(m));
    }
    expect([...seen].sort()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    // m5 had a new comment: from now on it is read on every poll.
    reads = [];
    await runner.runPoll();
    expect(reads).toContain("m5");
    reads = [];
    await runner.runPoll();
    expect(reads).toContain("m5");
    expect(client.calls.privateReplyText).toHaveLength(1);
  });

  it("says when nothing is switched on, and reads nothing", async () => {
    const report = await runner.runPoll();
    expect(report.idle).toBe(true);
    expect(reads).toEqual([]);
  });
});

describe("the start time of an automation", () => {
  it("does not answer a comment from before it started", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "a", media_id: "m1", since: Math.floor(Date.now() / 1000) + 3600 }));
    client.seedComments("m1", [[{ id: "old1", text: "link", igsid: "p1" }]]);
    await runner.runPoll();
    expect(client.calls.privateReplyText).toHaveLength(0);
    expect(await db.isCommentProcessed("old1")).toBe(true);
  });

  it("answers a comment made after it started", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "a", media_id: "m1", since: Math.floor(Date.now() / 1000) - 3600 }));
    client.seedComments("m1", [[{ id: "new1", text: "link", igsid: "p1" }]]);
    await runner.runPoll();
    expect(client.calls.privateReplyText).toHaveLength(1);
  });
});

describe("Instagram's rate-limit header", () => {
  it("gives the highest figure", () => {
    expect(usagePercent('{"17841400000000000":[{"type":"instagram","call_count":12,"total_cputime":3,"total_time":41,"estimated_time_to_regain_access":0}]}')).toBe(41);
    expect(usagePercent('{"call_count":7,"total_time":2,"total_cputime":1}')).toBe(7);
    expect(usagePercent("not json")).toBeNull();
  });
});

describe("Instagram's spam limit", () => {
  it("stops the tenant and doubles the wait while it lasts", async () => {
    const { InstagramApiError } = await import("../src/api/client");
    const err = new InstagramApiError("We limit how often you can post, comment or do other things in a given amount of time", 400, 100);
    expect(err.isRateLimit).toBe(true);
    await db.upsertCampaign(campaign({ campaign_id: "a", media_id: "m1" }));
    client.seedComments("m1", [[{ id: "s1", text: "link", igsid: "p1" }]]);
    client.rateLimitNext.privateReplyText = 5;
    const t0 = Math.floor(Date.now() / 1000);
    const first = await runner.runPoll();
    expect(first.rateLimited).toBe(true);
    const until1 = (await storage.get<number>("rate_limited_until"))!;
    expect(until1 - t0).toBeGreaterThanOrEqual(179);
    expect(until1 - t0).toBeLessThan(200);
    expect((await runner.runPoll()).skipped).toBe("cooldown");
    await storage.put("rate_limited_until", 0);
    await runner.runPoll();
    const until2 = (await storage.get<number>("rate_limited_until"))!;
    expect(until2 - t0).toBeGreaterThanOrEqual(359);
    expect(await storage.get("last_send_failure")).toMatchObject({ failure: "rate_limited" });
  });
});
