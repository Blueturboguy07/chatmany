-- Tenants, phase 1: every row learns which creator it belongs to.
--
-- Until now chatmany is single-tenant by construction, and deliberately so: `auth` is
-- `CHECK (id = 1)` — one row, one Instagram account — and every other table is implicitly
-- scoped to whoever that row belongs to. Self-hosting is what that shape is for: clone it,
-- `wrangler d1 create chatmany`, paste the database id, and the worker is yours.
--
-- The pooled deployment is the other half of the same product. publik runs ONE worker, and a
-- creator connects Instagram through publik and is done — no Cloudflare account, no D1 id, no
-- wrangler.toml. That only works if every row says which creator owns it.
--
-- THIS MIGRATION IS PURELY ADDITIVE, AND THAT IS A DELIBERATE STOPPING POINT.
--
-- It adds columns and one table. It changes no primary key, renames nothing, and drops
-- nothing, so every existing query in src/db.ts keeps working untouched and a self-hosted
-- database keeps behaving exactly as it did. `tenant_id` defaults to 'solo' everywhere,
-- which is precisely what those rows already meant.
--
-- The parts that CANNOT be additive are not here, on purpose — see phase 2 below. A first
-- draft of this file did do them, and it broke the entire engine suite in one step, because
-- changing a primary key or renaming a column requires rewiring src/db.ts in the same
-- breath. Shipping half of that to a worker that sends real DMs is how you get silent
-- message loss, so the split is the point, not an oversight.
--
-- ---------------------------------------------------------------------------
-- PHASE 2, still to do, and it must land as ONE change with its db.ts rewiring:
--
--   1. campaigns: PRIMARY KEY (campaign_id) -> (tenant_id, campaign_id).
--      Campaign ids are chosen by the creator. Two creators both naming a campaign
--      "launch" is not a curiosity, it is the default outcome.
--   2. conversations: PRIMARY KEY (igsid, campaign_id) -> (tenant_id, igsid, campaign_id).
--      Two creators can hold a conversation with the same Instagram user.
--   3. send_claims: PRIMARY KEY (key) -> (tenant_id, key). This is the at-most-once guard
--      for outbound DMs (0003). Sharing it across tenants would let one creator's claim
--      SUPPRESS another's send — the mirror image of the 142-duplicate-DM bug, and worse,
--      because it drops real messages silently instead of repeating them.
--   4. auth: drop CHECK (id = 1) and key on tenant_id, so the table holds one Meta token per
--      creator, plus a UNIQUE index on ig_user_id. Inbound webhooks are addressed to an
--      Instagram account, not to a tenant, so that index is what routes an event to its
--      owner — and two tenants claiming one account has to fail at connect time, not at 3am
--      on somebody's launch.
--
-- Until phase 2 lands, a pooled deployment is not safe to run with more than one tenant.
-- Phase 1 is what lets the metering, the roster and the connect flow be built and tested
-- against a real schema first.
-- ---------------------------------------------------------------------------

-- SQLite has no `add column if not exists`. Each of these runs once; a re-run fails loudly
-- on "duplicate column name" rather than silently doing something else, which is the right
-- failure for a migration runner that tracks what it has applied.

ALTER TABLE campaigns ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE conversations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE processed_comments ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE comment_actions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE kv ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';
ALTER TABLE send_claims ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'solo';

-- Lookups the pooled worker makes constantly: "every active campaign for this tenant" on
-- each poll tick, and "this tenant's events" for the dashboard. Both are prefixed by
-- tenant_id so one creator's traffic never scans another's rows.
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_media ON campaigns (tenant_id, media_id, active);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_state ON conversations (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events (tenant_id, campaign_id, type, created_at);

-- The tenant roster.
--
-- `publik_key` is the pk_live_ key this creator's usage is billed to. NULL means nobody is
-- billing this tenant, which is exactly what a self-hosted install is: it runs on the
-- creator's own Cloudflare account and their own Meta app, so publik is paying for none of
-- it. src/metering.ts skips a tenant with no key rather than inventing one.
--
-- `status` is what a 402 from publik turns into: 'paused' stops new sends for that creator
-- without touching anyone else's, and without deleting anything they own.
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id    TEXT PRIMARY KEY,
  publik_key   TEXT,
  status       TEXT NOT NULL DEFAULT 'active',   -- active | paused | disconnected
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The row every pre-existing install already is.
INSERT OR IGNORE INTO tenants (tenant_id, publik_key, status, created_at, updated_at)
  VALUES ('solo', NULL, 'active', 0, 0);
