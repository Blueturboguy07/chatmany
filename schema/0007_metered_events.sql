-- 0007: the metered-once ledger. One row per inbound comment or DM a tenant was charged for.
--
-- WHY (2026-11-16). `chatmany.event` was counted on every read, not once per event: the hosted
-- poll reads the newest 20 conversations every 15 seconds, and each inbound DM in them was
-- counted again on every poll. One test creator had 6,062 events for 7 comments. A comment can
-- also be read many times (a send waiting for a retry, an automation deleted and its
-- processed-comment rows with it, a webhook delivered twice). The runner now records an event
-- only when its key is new here:
--   c:<comment id>                 a comment (poll, sweep or webhook)
--   m:<message id>                 a DM (poll or webhook)
--   m:<sender>:<time>:<payload>    a DM whose transport gave no id
--
-- Additive: one new table, its index, and rows copied into it. No existing row changes.
-- Rows expire after 90 days with the other per-exchange records (src/tenant/retention.ts). That
-- cannot charge an event twice: a comment older than 7 days is never read again, and a DM older
-- than the message cursor is never counted again.

CREATE TABLE IF NOT EXISTS metered_events (
  tenant_id   TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_metered_events_created ON metered_events (created_at);

-- Comments already handled count as metered: they were counted (and are forgiven) under the old
-- rule, so deleting their automation must not count them again. Hosted tenants only; the
-- self-host Worker does not meter.
INSERT OR IGNORE INTO metered_events (tenant_id, event_key, created_at)
  SELECT tenant_id, 'c:' || comment_id, created_at FROM processed_comments WHERE tenant_id <> 'self';
