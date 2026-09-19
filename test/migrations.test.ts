// Migrations applied to a POPULATED database, in order, the way `wrangler d1 migrations apply`
// will run them against the founder's existing rows. The in-memory test DB is always empty, so
// nothing else here would catch a rebuild that loses data.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function migrations(): Array<[string, string]> {
  const dir = new URL("../schema/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as [string, string]);
}

describe("schema migrations", () => {
  it("carries an existing single-owner database over to the 'self' tenant without losing a row", () => {
    const db = new DatabaseSync(":memory:");
    const files = migrations();
    const upTo3 = files.filter(([n]) => n < "0004");
    const rest = files.filter(([n]) => n >= "0004");
    for (const [, sql] of upTo3) db.exec(sql);

    // A database that looks like the live one: campaigns, funnel rows, ledgers, events, kv.
    db.exec(`
      INSERT INTO campaigns (campaign_id, platform, media_id, config_json, active, updated_at)
        VALUES ('ghost-v2-606058', 'instagram', '17894559480606058', '{"campaign_id":"ghost-v2-606058"}', 1, 100);
      INSERT INTO campaigns (campaign_id, platform, media_id, config_json, active, updated_at, archived_at)
        VALUES ('kneecap-cut', 'instagram', '18114128635948094', '{"campaign_id":"kneecap-cut"}', 0, 90, 95);
      INSERT INTO conversations (igsid, campaign_id, state, username, followed, follow_retries, updated_at, created_at)
        VALUES ('user-1', 'ghost-v2-606058', 'DONE', 'someone', 0, 0, 101, 100);
      INSERT INTO processed_comments (comment_id, igsid, campaign_id, created_at) VALUES ('cm-1', 'user-1', 'ghost-v2-606058', 100);
      INSERT INTO comment_actions (comment_id, action, created_at) VALUES ('cm-1', 'public_reply', 100);
      INSERT INTO send_claims (key, created_at) VALUES ('opening:ghost-v2-606058:cm-1', 100);
      INSERT INTO events (campaign_id, igsid, type, created_at) VALUES ('ghost-v2-606058', 'user-1', 'delivered', 100);
      INSERT INTO kv (key, value, updated_at) VALUES ('last_poll_ts', '100', 100);
      INSERT INTO auth (id, access_token, ig_user_id, username, expires_at) VALUES (1, 'token', 'ig-1', 'mann', 999999);
    `);

    for (const [, sql] of rest) db.exec(sql);

    const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
    expect(one("SELECT COUNT(*) AS n FROM campaigns").n).toBe(2);
    expect(one("SELECT tenant_id FROM campaigns WHERE campaign_id = 'ghost-v2-606058'").tenant_id).toBe("self");
    expect(one("SELECT archived_at FROM campaigns WHERE campaign_id = 'kneecap-cut'").archived_at).toBe(95);
    expect(one("SELECT tenant_id, state FROM conversations").state).toBe("DONE");
    expect(one("SELECT tenant_id FROM processed_comments").tenant_id).toBe("self");
    expect(one("SELECT tenant_id FROM comment_actions").tenant_id).toBe("self");
    expect(one("SELECT tenant_id FROM send_claims").tenant_id).toBe("self");
    expect(one("SELECT tenant_id, id FROM events").id).toBe(1); // autoincrement ids preserved
    expect(one("SELECT value FROM kv WHERE key = 'last_poll_ts'").value).toBe("100");
    // auth is untouched: the self-host path keeps its single-owner token table.
    expect(one("SELECT ig_user_id FROM auth").ig_user_id).toBe("ig-1");
  });

  it("leaves tenant_id first in every hot-path index", () => {
    const db = new DatabaseSync(":memory:");
    for (const [, sql] of migrations()) db.exec(sql);
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.sql]));
    for (const idx of ["idx_conversations_state", "idx_campaigns_media", "idx_events_campaign", "idx_events_type_time"]) {
      expect(byName[idx], `${idx} is missing`).toBeTruthy();
      expect(byName[idx]!.replace(/\s+/g, " ")).toMatch(/\(\s*tenant_id/);
    }
  });

  it("applies cleanly on a fresh database too", () => {
    const db = new DatabaseSync(":memory:");
    for (const [, sql] of migrations()) db.exec(sql);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
    expect(tables).toEqual(expect.arrayContaining(["tenants", "usage_monthly", "campaigns", "events", "auth"]));
    // No rebuild leftovers.
    expect(tables.filter((t) => t.endsWith("_new"))).toEqual([]);
  });
});
