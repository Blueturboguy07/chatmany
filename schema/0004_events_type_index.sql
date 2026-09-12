-- Index for the account-wide hourly opening cap (commentPoll -> countEventsGlobal).
--
-- That query is `SELECT COUNT(*) FROM events WHERE type = ? AND created_at >= ?` and runs once
-- per poll tick (every 90s, ~960x/day). idx_events_campaign leads with campaign_id, so a global
-- count could not use it and full-scanned `events` every tick. With a few thousand rows in the
-- table that alone read ~5.3M rows/day and tripped D1's free-tier daily row-read limit
-- (5M/day) on 2026-09-01, which hard-fails EVERY D1 read — API and cron alike — until 00:00 UTC.
-- Leading with `type` lets the count seek straight to the last hour's openings instead.
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events (type, created_at);
