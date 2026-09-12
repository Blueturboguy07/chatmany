-- TikTok support. A second, single-row auth table keeps the Instagram row (auth.id = 1) untouched,
-- and conversations learn the TikTok conversation_id they must be answered on (Business Messaging
-- sends are addressed to a conversation, not a user).

CREATE TABLE IF NOT EXISTS tiktok_auth (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  access_token        TEXT NOT NULL,          -- short-term token, valid ~1 day
  refresh_token       TEXT NOT NULL,          -- valid ~1 year; used by the minute cron to roll access_token
  business_id         TEXT NOT NULL,          -- open_id from /tt_user/oauth2/token/, passed as business_id everywhere
  username            TEXT,
  display_name        TEXT,
  profile_image       TEXT,
  scope               TEXT,                   -- comma-separated scopes actually granted
  expires_at          INTEGER NOT NULL,       -- access_token expiry, unix seconds
  refresh_expires_at  INTEGER NOT NULL,       -- refresh_token expiry, unix seconds
  refreshed_at        INTEGER
);

ALTER TABLE conversations ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_platform_active ON campaigns (platform, active);
