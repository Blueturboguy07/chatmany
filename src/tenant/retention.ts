// Retention: per-exchange records are deleted 90 days after they are written (hosted mode only).
//
// publik's privacy page (publikhq.com/privacy#chatmany) promises that every per-exchange record
// "expires 90 days after it is written, whether or not anyone asks" (memo R30 D10). This is the
// job that makes it true. It runs once a day from the `0 3 * * *` cron on the hosted deployment.
//
// What goes, across every tenant, by the time each row was written or last changed:
//   events              created_at   the dashboard's counted actions (who, which automation)
//   processed_comments  created_at   which comment was handled, and by whom
//   comment_actions     created_at   the public reply / like ledger per comment
//   send_claims         created_at   the once-only send keys
//   metered_events      created_at   the once-only billing keys (a comment or message id)
//   conversations       updated_at   the people list: Instagram-scoped id, username, email if given
//
// What stays: automations (the creator deletes those), the tenant row (disconnect deletes it),
// the per-tenant cursors in `kv`, and `usage_monthly` (counts only, part of the billing history).
//
// WHY THIS CANNOT RE-SEND A DM. A processed-comment row is what stops a comment being answered
// twice. Deleting it is safe only because a comment that old can never be answered again:
// Instagram accepts a private reply within 7 days of the comment (engine.ts), and the runner no
// longer reads comments older than that at all (runner.ts ACTIONABLE_COMMENT_SECONDS). 90 days is
// far outside both.
//
// Deletes run in batches by rowid so one run never holds D1 for long, and a very large backlog
// drains over a few days instead of timing out.

export const RETENTION_DAYS = 90;
export const RETENTION_SECONDS = RETENTION_DAYS * 86400;

/** Table → the column that says when the row was last written. */
export const RETAINED_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["events", "created_at"],
  ["processed_comments", "created_at"],
  ["comment_actions", "created_at"],
  ["send_claims", "created_at"],
  ["metered_events", "created_at"],
  ["conversations", "updated_at"],
];

export interface PurgeOptions {
  /** Rows per DELETE. */
  batch?: number;
  /** DELETEs per table per run. */
  maxBatches?: number;
}

/** Delete every retained row older than 90 days. Returns rows deleted per table. */
export async function purgeExpired(db: D1Database, nowSeconds: number, opts: PurgeOptions = {}): Promise<Record<string, number>> {
  const batch = opts.batch ?? 5000;
  const maxBatches = opts.maxBatches ?? 20;
  const cutoff = nowSeconds - RETENTION_SECONDS;
  const deleted: Record<string, number> = {};
  for (const [table, column] of RETAINED_TABLES) {
    deleted[table] = 0;
    for (let i = 0; i < maxBatches; i++) {
      const res = await db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
        .bind(cutoff, batch)
        .run();
      const n = Number(res.meta?.changes ?? 0);
      deleted[table] += n;
      if (n < batch) break;
    }
  }
  return deleted;
}
