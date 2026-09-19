// Tenant isolation — the property the whole hosted design exists to provide.
//
// Two tenants, ONE shared D1, one Durable Object's worth of state each. A viral post on tenant A
// must not cost tenant B a single DM. On 2026-08-23 it did: one account-wide tick did every
// campaign's work, was killed by Cloudflare mid-loop, and the comments it had not reached yet
// were silently never served.

import { beforeEach, describe, expect, it } from "vitest";
import { TenantRunner } from "../src/tenant/runner";
import { TenantDb } from "../src/tenant/db";
import { UsageMeter, UNIT_EVENT, UNIT_SEND } from "../src/tenant/metering";
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

interface Harness {
  db: TenantDb;
  client: FakeClient;
  storage: FakeStorage;
  runner: TenantRunner;
  posted: unknown[];
}

let sharedDb: D1Database;

function makeTenant(d1: D1Database, tenantId: string, mediaId: string, comments: number): Harness {
  const db = new TenantDb(d1, tenantId);
  const client = new FakeClient();
  const storage = new FakeStorage();
  const posted: unknown[] = [];
  const meter = new UsageMeter({
    tenantId,
    publikUserId: `u_${tenantId}`,
    storage,
    db,
    endpoint: "https://publikhq.test",
    token: "ingest",
    fetcher: (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  client.seedComments(mediaId, [
    Array.from({ length: comments }, (_, i) => ({ id: `${tenantId}-c${i}`, text: "link", igsid: `${tenantId}-u${i}` })),
  ]);
  const runner = new TenantRunner({
    tenantId,
    db,
    storage,
    client: client.asClient(),
    meter,
    igUserId: `${tenantId}-owner`,
    limits: { sendIntervalMs: 0 },
  });
  return { db, client, storage, runner, posted };
}

beforeEach(() => {
  sharedDb = makeTestDb();
});

describe("a flood on one tenant does not starve another", () => {
  it("caps the viral tenant at its per-run send budget while the quiet tenant is served in full", async () => {
    const viral = makeTenant(sharedDb, "t_viral", "media-v", 300);
    const quiet = makeTenant(sharedDb, "t_quiet", "media-q", 2);
    await viral.db.upsertCampaign(campaign({ campaign_id: "cv", media_id: "media-v" }), true);
    await quiet.db.upsertCampaign(campaign({ campaign_id: "cq", media_id: "media-q" }), true);

    const vReport = await viral.runner.runPoll();
    const qReport = await quiet.runner.runPoll();

    // The viral tenant yields at 25 sends per run instead of running until Cloudflare kills it.
    expect(vReport.sends).toBe(25);
    expect(viral.client.calls.privateReplyText).toHaveLength(25);
    // ...and the quiet tenant is entirely unaffected.
    expect(qReport.sends).toBe(2);
    expect(quiet.client.calls.privateReplyText).toHaveLength(2);

    // The viral tenant's backlog is still there for its next run: nothing was lost.
    const remaining = await viral.db.processedCommentIds(
      Array.from({ length: 300 }, (_, i) => `t_viral-c${i}`),
    );
    expect(remaining.size).toBe(25);
    const second = await viral.runner.runPoll();
    expect(second.sends).toBe(25);
  });

  it("one tenant's 613 cooldown does not stop another tenant sending", async () => {
    const limited = makeTenant(sharedDb, "t_limited", "media-l", 3);
    const other = makeTenant(sharedDb, "t_other", "media-o", 3);
    await limited.db.upsertCampaign(campaign({ campaign_id: "cl", media_id: "media-l" }), true);
    await other.db.upsertCampaign(campaign({ campaign_id: "co", media_id: "media-o" }), true);

    limited.client.rateLimitNext.privateReplyText = 1;
    const first = await limited.runner.runPoll();
    expect(first.rateLimited).toBe(true);
    expect(await limited.runner.cooldownUntil()).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The cooldown is that tenant's own object state...
    const second = await limited.runner.runPoll();
    expect(second.skipped).toBe("cooldown");
    expect(second.sends).toBe(0);

    // ...and says nothing about anyone else.
    expect(await other.runner.cooldownUntil()).toBe(0);
    const otherReport = await other.runner.runPoll();
    expect(otherReport.sends).toBe(3);
  });

  it("no tenant can read or write another tenant's rows through TenantDb", async () => {
    const a = makeTenant(sharedDb, "t_a", "media-a", 1);
    const b = makeTenant(sharedDb, "t_b", "media-b", 1);
    await a.db.upsertCampaign(campaign({ campaign_id: "shared-id", media_id: "media-a" }), true);
    await b.db.upsertCampaign(campaign({ campaign_id: "shared-id", media_id: "media-b" }), true);

    // Same campaign_id in one D1: each tenant sees only its own.
    expect((await a.db.getCampaign("shared-id"))?.media_id).toBe("media-a");
    expect((await b.db.getCampaign("shared-id"))?.media_id).toBe("media-b");
    expect(await a.db.getActiveCampaigns()).toHaveLength(1);

    await a.runner.runPoll();
    await b.runner.runPoll();

    // Ledgers, conversations and events stay separate even with colliding ids.
    expect(await a.db.isCommentProcessed("t_a-c0")).toBe(true);
    expect(await b.db.isCommentProcessed("t_a-c0")).toBe(false);
    expect(await a.db.listConversations(null)).toHaveLength(1);
    expect(await b.db.listConversations(null)).toHaveLength(1);
    expect((await a.db.eventCountsByType(null, 0)).delivered).toBe(1);
    expect((await b.db.eventCountsByType(null, 0)).delivered).toBe(1);

    // A claim held by one tenant does not block the other's identically-keyed send.
    expect(await a.db.claimSend("opening:shared-id:x")).toBe(true);
    expect(await b.db.claimSend("opening:shared-id:x")).toBe(true);
  });

  it("meters each tenant's units against that tenant only", async () => {
    const a = makeTenant(sharedDb, "t_a", "media-a", 4);
    const b = makeTenant(sharedDb, "t_b", "media-b", 1);
    await a.db.upsertCampaign(campaign({ campaign_id: "ca", media_id: "media-a" }), true);
    await b.db.upsertCampaign(campaign({ campaign_id: "cb", media_id: "media-b" }), true);

    await a.runner.runPoll();
    await b.runner.runPoll();
    await a.runner.flushUsage(true);
    await b.runner.flushUsage(true);

    const usageA = Object.fromEntries((await a.db.usageForMonth()).map((r) => [r.slug, r.units]));
    const usageB = Object.fromEntries((await b.db.usageForMonth()).map((r) => [r.slug, r.units]));
    expect(usageA[UNIT_EVENT]).toBe(4);
    expect(usageA[UNIT_SEND]).toBe(4);
    expect(usageB[UNIT_EVENT]).toBe(1);
    expect(usageB[UNIT_SEND]).toBe(1);
  });
});

describe("pausing for credit stops sends, not ingestion", () => {
  it("keeps recording comments so a top-up resumes the backlog in order", async () => {
    const t = makeTenant(sharedDb, "t_broke", "media-x", 3);
    await t.db.upsertCampaign(campaign({ campaign_id: "cx", media_id: "media-x" }), true);
    await t.storage.put("paused_credit", true);

    const report = await t.runner.runPoll();
    expect(report.skipped).toBe("credit");
    expect(t.client.calls.privateReplyText).toHaveLength(0);
    // The poll tick itself is still a metered unit of publik's infrastructure.
    await t.runner.flushUsage(true);
    expect((await t.db.usageForMonth()).some((r) => r.units > 0)).toBe(true);

    await t.storage.put("paused_credit", false);
    const after = await t.runner.runPoll();
    expect(after.sends).toBe(3);
  });
});
