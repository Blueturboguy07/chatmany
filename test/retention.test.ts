// The 90-day retention job: publikhq.com/privacy#chatmany says every per-exchange record expires
// 90 days after it is written. This proves the job deletes exactly those rows, for every tenant,
// and leaves automations, tenants and billing counts alone.

import { describe, expect, it } from "vitest";
import { TenantDb } from "../src/tenant/db";
import { RETAINED_TABLES, RETENTION_SECONDS, purgeExpired } from "../src/tenant/retention";
import { makeTestDb } from "./helpers/fakeD1";

const NOW = 1_800_000_000;
const OLD = NOW - RETENTION_SECONDS - 60;
const FRESH = NOW - RETENTION_SECONDS + 3600;

async function seed(d1: D1Database, tenant: string, at: number, tag: string) {
  await d1
    .prepare("INSERT INTO events (tenant_id, campaign_id, igsid, type, created_at) VALUES (?, 'c1', ?, 'opening_sent', ?)")
    .bind(tenant, `u-${tag}`, at)
    .run();
  await d1
    .prepare("INSERT INTO processed_comments (tenant_id, comment_id, igsid, campaign_id, created_at) VALUES (?, ?, ?, 'c1', ?)")
    .bind(tenant, `cm-${tag}`, `u-${tag}`, at)
    .run();
  await d1
    .prepare("INSERT INTO comment_actions (tenant_id, comment_id, action, created_at) VALUES (?, ?, 'public_reply', ?)")
    .bind(tenant, `cm-${tag}`, at)
    .run();
  await d1.prepare("INSERT INTO send_claims (tenant_id, key, created_at) VALUES (?, ?, ?)").bind(tenant, `k-${tag}`, at).run();
  await d1.prepare("INSERT INTO metered_events (tenant_id, event_key, created_at) VALUES (?, ?, ?)").bind(tenant, `c:cm-${tag}`, at).run();
  await d1
    .prepare(
      "INSERT INTO conversations (tenant_id, igsid, campaign_id, state, username, email, updated_at, created_at) VALUES (?, ?, 'c1', 'DONE', ?, ?, ?, ?)",
    )
    .bind(tenant, `u-${tag}`, `handle_${tag}`, `${tag}@example.com`, at, at)
    .run();
}

async function count(d1: D1Database, table: string, tenant: string): Promise<number> {
  const row = await d1.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).bind(tenant).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("purgeExpired", () => {
  it("deletes per-exchange rows older than 90 days for every tenant and keeps newer ones", async () => {
    const d1 = makeTestDb();
    for (const tenant of ["t_a", "t_b"]) {
      await seed(d1, tenant, OLD, `${tenant}-old`);
      await seed(d1, tenant, FRESH, `${tenant}-new`);
    }
    const deleted = await purgeExpired(d1, NOW);
    for (const [table] of RETAINED_TABLES) {
      expect(deleted[table], table).toBe(2);
      expect(await count(d1, table, "t_a"), table).toBe(1);
      expect(await count(d1, table, "t_b"), table).toBe(1);
    }
    // The username and email of the old contact are gone; the recent one stays.
    const people = await d1.prepare("SELECT username FROM conversations ORDER BY username").all<{ username: string }>();
    expect(people.results.map((r) => r.username)).toEqual(["handle_t_a-new", "handle_t_b-new"]);
  });

  it("keeps automations and billing counts", async () => {
    const d1 = makeTestDb();
    const db = new TenantDb(d1, "t_a");
    await db.upsertCampaign(
      { campaign_id: "c1", media_id: "m1", keywords: ["link"], reward: { type: "link", value: "https://x.test" }, copy: { opening: "o", delivery: "d" } } as never,
      true,
    );
    await db.addUsage("chatmany.send", 5, "2026-01");
    await d1.prepare("UPDATE campaigns SET updated_at = ?").bind(OLD).run();
    await purgeExpired(d1, NOW);
    expect(await count(d1, "campaigns", "t_a")).toBe(1);
    expect(await count(d1, "usage_monthly", "t_a")).toBe(1);
  });

  it("drains a large backlog in batches and says how many rows went", async () => {
    const d1 = makeTestDb();
    for (let i = 0; i < 25; i++) await seed(d1, "t_a", OLD, `old-${i}`);
    const first = await purgeExpired(d1, NOW, { batch: 10, maxBatches: 2 });
    expect(first.events).toBe(20);
    const second = await purgeExpired(d1, NOW, { batch: 10, maxBatches: 2 });
    expect(second.events).toBe(5);
    expect(await count(d1, "events", "t_a")).toBe(0);
  });
});
