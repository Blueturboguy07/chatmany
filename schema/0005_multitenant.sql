-- Multi-tenant mode (publik-hosted chatmany). R30 §3.2.
--
-- The self-host path (one Cloudflare account, one creator, one Meta app) stays supported —
-- R30 D6. It keeps using exactly these tables under the reserved tenant id 'self', which is the
-- default on every column added here, so a self-host database that applies this migration keeps
-- working with no code or config change.
--
-- The hosted path adds a `tenants` row per creator and puts tenant_id FIRST in every primary key
-- and every hot-path index, so one tenant's rows are a contiguous index prefix and no query can
-- read another tenant's rows by accident. Access goes through exactly one choke point, the
-- TenantDb class (src/tenant/db.ts), which binds tenant_id on every statement. This is the
-- logical separation Meta's Platform Terms §5.b.ii.2 requires of a Service Provider
-- ("Platform Data you maintain on behalf of one Client is maintained separately from that of
-- other Clients"); physical separation (one DO SQLite per tenant) costs the same per row written
-- and stays available later.
--
-- SQLite cannot add a column to a PRIMARY KEY, so each table is rebuilt: create, copy, drop,
-- rename, re-index.

-- ---------------------------------------------------------------- registry

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id              TEXT PRIMARY KEY,
  publik_user_id         TEXT,                 -- null until the creator claims the install
  publik_install_id      TEXT,
  ig_user_id             TEXT UNIQUE,          -- set at connect; also routes path-T webhooks
  username               TEXT,
  account_type           TEXT,
  meta_app_kind          TEXT NOT NULL DEFAULT 'creator' CHECK (meta_app_kind IN ('creator','publik')),
  meta_app_id            TEXT,
  meta_app_secret_enc    TEXT,                 -- AES-256-GCM, AAD = tenant_id (src/tenant/crypto.ts)
  meta_token_encrypted   TEXT,                 -- AES-256-GCM, AAD = tenant_id
  meta_token_expires_at  INTEGER,
  token_refreshed_at     INTEGER,
  webhook_verify_token   TEXT,
  webhook_verified_at    INTEGER,
  mode                   TEXT NOT NULL DEFAULT 'polling' CHECK (mode IN ('webhook','polling')),
  status                 TEXT NOT NULL DEFAULT 'connecting'
                           CHECK (status IN ('connecting','active','paused_credit','paused_meta','disconnected')),
  paused_reason          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_mode ON tenants (mode, status);
CREATE INDEX IF NOT EXISTS idx_tenants_publik_user ON tenants (publik_user_id);

-- Per-tenant metered units, by calendar month, in the three billable classes.
--
-- THIS TABLE IS UNITS ONLY — NEVER MONEY. The charge is set publik-side from publik's REAL
-- Cloudflare bill: while publik's marginal cost for a unit class is zero (inside the included
-- quotas) the creator is charged zero for it, and once the bill for that class is non-zero the
-- rate for that month is (real marginal monthly cost / metered units that month) x 1.03.
-- `SUM(units) GROUP BY slug, month` over this table is the denominator of that formula, and
-- per-tenant `units` is the multiplier. No Cloudflare list price appears anywhere in this repo.
CREATE TABLE IF NOT EXISTS usage_monthly (
  tenant_id   TEXT NOT NULL,
  month       TEXT NOT NULL,                  -- 'YYYY-MM' (UTC)
  slug        TEXT NOT NULL,                  -- chatmany.event | chatmany.send | chatmany.poll
  units       INTEGER NOT NULL DEFAULT 0,     -- metered by the tenant's Durable Object
  reported    INTEGER NOT NULL DEFAULT 0,     -- units publik acknowledged (units - reported = in flight)
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, month, slug)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_month ON usage_monthly (month, slug);

-- ---------------------------------------------------------------- rebuilds

CREATE TABLE conversations_new (
  tenant_id      TEXT NOT NULL DEFAULT 'self',
  igsid          TEXT NOT NULL,
  campaign_id    TEXT NOT NULL,
  state          TEXT NOT NULL,
  username       TEXT,
  email          TEXT,
  followed       INTEGER DEFAULT 0,
  follow_retries INTEGER DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, igsid, campaign_id)
);
INSERT INTO conversations_new
  (tenant_id, igsid, campaign_id, state, username, email, followed, follow_retries, updated_at, created_at)
  SELECT 'self', igsid, campaign_id, state, username, email, followed, follow_retries, updated_at, created_at
  FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_conversations_person ON conversations (tenant_id, igsid);

CREATE TABLE processed_comments_new (
  tenant_id    TEXT NOT NULL DEFAULT 'self',
  comment_id   TEXT NOT NULL,
  igsid        TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, comment_id)
);
INSERT INTO processed_comments_new (tenant_id, comment_id, igsid, campaign_id, created_at)
  SELECT 'self', comment_id, igsid, campaign_id, created_at FROM processed_comments;
DROP TABLE processed_comments;
ALTER TABLE processed_comments_new RENAME TO processed_comments;

CREATE TABLE comment_actions_new (
  tenant_id    TEXT NOT NULL DEFAULT 'self',
  comment_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, comment_id, action)
);
INSERT INTO comment_actions_new (tenant_id, comment_id, action, created_at)
  SELECT 'self', comment_id, action, created_at FROM comment_actions;
DROP TABLE comment_actions;
ALTER TABLE comment_actions_new RENAME TO comment_actions;

CREATE TABLE send_claims_new (
  tenant_id  TEXT NOT NULL DEFAULT 'self',
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO send_claims_new (tenant_id, key, created_at)
  SELECT 'self', key, created_at FROM send_claims;
DROP TABLE send_claims;
ALTER TABLE send_claims_new RENAME TO send_claims;

CREATE TABLE kv_new (
  tenant_id   TEXT NOT NULL DEFAULT 'self',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO kv_new (tenant_id, key, value, updated_at)
  SELECT 'self', key, value, updated_at FROM kv;
DROP TABLE kv;
ALTER TABLE kv_new RENAME TO kv;

CREATE TABLE campaigns_new (
  tenant_id    TEXT NOT NULL DEFAULT 'self',
  campaign_id  TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'instagram',
  media_id     TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  active       INTEGER DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  PRIMARY KEY (tenant_id, campaign_id)
);
INSERT INTO campaigns_new (tenant_id, campaign_id, platform, media_id, config_json, active, updated_at, archived_at)
  SELECT 'self', campaign_id, platform, media_id, config_json, active, updated_at, archived_at FROM campaigns;
DROP TABLE campaigns;
ALTER TABLE campaigns_new RENAME TO campaigns;
CREATE INDEX IF NOT EXISTS idx_campaigns_media ON campaigns (tenant_id, media_id, active);

CREATE TABLE events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL DEFAULT 'self',
  campaign_id  TEXT NOT NULL,
  igsid        TEXT,
  type         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
INSERT INTO events_new (id, tenant_id, campaign_id, igsid, type, created_at)
  SELECT id, 'self', campaign_id, igsid, type, created_at FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
-- Both hot-path counts keep an index whose PREFIX matches their WHERE clause (the 2026-09-01
-- lesson): per-campaign dashboard counts, and the per-tenant hourly send cap.
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events (tenant_id, campaign_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events (tenant_id, type, created_at);
