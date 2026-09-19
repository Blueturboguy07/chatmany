// The backlog sweep — the fix for the newest-100 read window.
//
// On the ghost reel (14,146 comments) the poller only ever read the newest 100 top-level
// comments of a post. A refused send released its claim to be retried, but by the next tick the
// comment had scrolled out of that window: ~1,850 people were never seen at all, and the ones
// whose sends failed were never reached again. The sweep walks the post's history from a stored
// cursor, a few pages per run, rotating between posts.

import { beforeEach, describe, expect, it } from "vitest";
import { TenantRunner } from "../src/tenant/runner";
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

let d1: D1Database;
let db: TenantDb;
let client: FakeClient;
let storage: FakeStorage;
let runner: TenantRunner;

beforeEach(async () => {
  d1 = makeTestDb();
  db = new TenantDb(d1, "t_sweep");
  client = new FakeClient();
  storage = new FakeStorage();
  runner = new TenantRunner({
    tenantId: "t_sweep",
    db,
    storage,
    client: client.asClient(),
    meter: new UsageMeter({
      tenantId: "t_sweep",
      publikUserId: null,
      storage,
      db,
      endpoint: "https://publikhq.test",
      token: "x",
      fetcher: (async () => new Response("{}")) as unknown as typeof fetch,
    }),
    igUserId: "owner",
    limits: { sendIntervalMs: 0, sweepPagesPerRun: 2, maxSendsPerRun: 100 },
  });
});

describe("runSweep", () => {
  it("reaches comments the newest page no longer shows, walking pages from a stored cursor", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "cs", media_id: "m1" }), true);
    // Five pages of history; only page 0 is what a poll tick ever sees.
    client.seedComments(
      "m1",
      Array.from({ length: 5 }, (_, p) =>
        Array.from({ length: 3 }, (_, i) => ({ id: `p${p}-c${i}`, text: "link", igsid: `p${p}-u${i}` })),
      ),
    );

    await runner.runPoll();
    expect(client.calls.privateReplyText).toHaveLength(3); // page 0 only

    // Each sweep run walks two more pages and remembers where it stopped.
    await runner.runSweep();
    expect(client.calls.privateReplyText).toHaveLength(6); // pages 0-1 (page 0 already processed)
    await runner.runSweep();
    expect(client.calls.privateReplyText).toHaveLength(12);
    await runner.runSweep();
    expect(client.calls.privateReplyText).toHaveLength(15); // the whole history, once each

    // At the end of history the cursor resets, and nothing is sent twice.
    await runner.runSweep();
    expect(client.calls.privateReplyText).toHaveLength(15);
  });

  it("rotates between posts instead of starving the later ones", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "c1", media_id: "m1" }), true);
    await db.upsertCampaign(campaign({ campaign_id: "c2", media_id: "m2" }), true);
    client.seedComments("m1", [[{ id: "m1-a", text: "link", igsid: "u1" }]]);
    client.seedComments("m2", [[{ id: "m2-a", text: "link", igsid: "u2" }]]);

    await runner.runSweep();
    await runner.runSweep();

    const ids = client.calls.privateReplyText.map((c) => (c as { commentId: string }).commentId).sort();
    expect(ids).toEqual(["m1-a", "m2-a"]);
  });

  it("does not sweep while the tenant is in a 613 cooldown", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "cs", media_id: "m1" }), true);
    client.seedComments("m1", [[{ id: "a", text: "link", igsid: "u" }]]);
    await storage.put("rate_limited_until", Math.floor(Date.now() / 1000) + 120);

    const report = await runner.runSweep();
    expect(report.skipped).toBe("cooldown");
    expect(client.calls.privateReplyText).toHaveLength(0);
  });

  it("skips the account's own comments", async () => {
    await db.upsertCampaign(campaign({ campaign_id: "cs", media_id: "m1" }), true);
    client.seedComments("m1", [[{ id: "mine", text: "link", igsid: "owner" }]]);
    await runner.runSweep();
    expect(client.calls.privateReplyText).toHaveLength(0);
  });
});
