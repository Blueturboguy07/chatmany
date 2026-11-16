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

/** D1 allows 10 GB for one database on the paid plan. */
export const D1_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
/** The daily job warns from this share of the limit, so there is time to move data. */
export const D1_WARN_SHARE = 0.6;

export interface StorageReport {
  size_bytes: number | null;
  limit_bytes: number;
  share: number | null;
  warn: boolean;
  tenants: number;
  rows: Record<string, number>;
  bytes_per_tenant: number | null;
  /** Tenants the database can hold at the present mean size, to the warn line. */
  tenants_to_warn: number | null;
  largest: Array<{ tenant_id: string; rows: number }>;
}

/**
 * How full the shared database is. D1 reports the size with every query (meta.size_after), so
 * the figure is Cloudflare's own. Every tenant's rows are in this one database; this is the
 * number that says when they must move to their own storage.
 */
export async function storageReport(db: D1Database): Promise<StorageReport> {
  const probe = await db.prepare("SELECT COUNT(*) AS n FROM tenants").run();
  const size = Number((probe.meta as { size_after?: number } | undefined)?.size_after ?? NaN);
  const tenants = Number((probe.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const rows: Record<string, number> = {};
  for (const [table] of RETAINED_TABLES) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    rows[table] = Number(r?.n ?? 0);
  }
  const big = await db
    .prepare(
      `SELECT tenant_id, SUM(n) AS rows FROM (
         SELECT tenant_id, COUNT(*) AS n FROM processed_comments GROUP BY tenant_id
         UNION ALL SELECT tenant_id, COUNT(*) AS n FROM events GROUP BY tenant_id
         UNION ALL SELECT tenant_id, COUNT(*) AS n FROM conversations GROUP BY tenant_id
         UNION ALL SELECT tenant_id, COUNT(*) AS n FROM metered_events GROUP BY tenant_id
       ) GROUP BY tenant_id ORDER BY rows DESC LIMIT 10`,
    )
    .all<{ tenant_id: string; rows: number }>();
  const sizeBytes = Number.isFinite(size) ? size : null;
  const share = sizeBytes === null ? null : sizeBytes / D1_LIMIT_BYTES;
  const perTenant = sizeBytes !== null && tenants > 0 ? Math.round(sizeBytes / tenants) : null;
  return {
    size_bytes: sizeBytes,
    limit_bytes: D1_LIMIT_BYTES,
    share,
    warn: share !== null && share >= D1_WARN_SHARE,
    tenants,
    rows,
    bytes_per_tenant: perTenant,
    tenants_to_warn: perTenant ? Math.floor((D1_LIMIT_BYTES * D1_WARN_SHARE) / perTenant) : null,
    largest: (big.results ?? []).map((r) => ({ tenant_id: r.tenant_id, rows: Number(r.rows) })),
  };
}
