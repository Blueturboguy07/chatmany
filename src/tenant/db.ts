// TenantDb — the ONE place any query touches campaign/conversation/event data.
//
// Every statement below binds tenant_id as its first bound parameter and every table's primary
// key and hot-path index starts with tenant_id (schema/0005_multitenant.sql), so a tenant's rows
// are a contiguous index prefix: no query can read another tenant's rows, and none of them can
// full-scan a shared table the way the 2026-09-01 `countEventsGlobal` did.
//
// The self-host path (R30 D6, still supported) is not a second implementation — src/db.ts is a
// set of thin delegates onto this class bound to the reserved tenant id 'self'. One SQL surface,
// two callers, nothing to drift.

import type { Campaign, EventType, State } from "../types";
import { validateCampaign } from "../config";

/** The reserved tenant id used by the single-owner self-host deployment. */
export const SELF_TENANT = "self";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export interface ConversationRow {
  igsid: string;
  campaign_id: string;
  state: State;
  username: string | null;
  email: string | null;
  followed: number;
  follow_retries: number;
  updated_at: number;
  created_at: number;
}

export interface CampaignListItem {
  campaign: Campaign;
  active: boolean;
  archived: boolean;
  updated_at: number;
}

export class TenantDb {
  constructor(
    private readonly db: D1Database,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error("TenantDb requires a tenant id");
  }

  // ---- campaigns ----

  /** Active, non-archived campaigns for this tenant (Section 10: conserve rate budget). */
  async getActiveCampaigns(): Promise<Campaign[]> {
    const rows = await this.db
      .prepare(
        "SELECT config_json FROM campaigns WHERE tenant_id = ? AND active = 1 AND archived_at IS NULL",
      )
      .bind(this.tenantId)
      .all<{ config_json: string }>();
    const out: Campaign[] = [];
    for (const r of rows.results ?? []) {
      try {
        out.push(validateCampaign(JSON.parse(r.config_json)));
      } catch {
        // Skip malformed rows rather than aborting the whole poll.
      }
    }
    return out;
  }

  async getCampaign(campaignId: string): Promise<Campaign | null> {
    const row = await this.db
      .prepare("SELECT config_json FROM campaigns WHERE tenant_id = ? AND campaign_id = ?")
      .bind(this.tenantId, campaignId)
      .first<{ config_json: string }>();
    if (!row) return null;
    try {
      return validateCampaign(JSON.parse(row.config_json));
    } catch {
      return null;
    }
  }

  async getAllCampaigns(opts: { archived?: boolean } = {}): Promise<CampaignListItem[]> {
    const where = opts.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
    const rows = await this.db
      .prepare(
        `SELECT config_json, active, updated_at, archived_at FROM campaigns
         WHERE tenant_id = ? AND ${where} ORDER BY updated_at DESC`,
      )
      .bind(this.tenantId)
      .all<{ config_json: string; active: number; updated_at: number; archived_at: number | null }>();
    const out: CampaignListItem[] = [];
    for (const r of rows.results ?? []) {
      try {
        out.push({
          campaign: validateCampaign(JSON.parse(r.config_json)),
          active: r.active === 1,
          archived: r.archived_at != null,
          updated_at: r.updated_at,
        });
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  async setCampaignActive(campaignId: string, active: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE campaigns SET active = ?, updated_at = ? WHERE tenant_id = ? AND campaign_id = ?")
      .bind(active ? 1 : 0, now(), this.tenantId, campaignId)
      .run();
  }

  async setCampaignArchived(campaignId: string, archived: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE campaigns SET archived_at = ?, updated_at = ? WHERE tenant_id = ? AND campaign_id = ?")
      .bind(archived ? now() : null, now(), this.tenantId, campaignId)
      .run();
  }

  /**
   * Delete a campaign and everything tied to it — conversations, the processed-comment
   * idempotency log, and its events. Without this a later campaign created with the same
   * campaign_id silently inherits the old one's "already messaged this person" dedup rows.
   */
  async deleteCampaign(campaignId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM campaigns WHERE tenant_id = ? AND campaign_id = ?").bind(this.tenantId, campaignId),
      this.db.prepare("DELETE FROM conversations WHERE tenant_id = ? AND campaign_id = ?").bind(this.tenantId, campaignId),
      this.db
        .prepare("DELETE FROM processed_comments WHERE tenant_id = ? AND campaign_id = ?")
        .bind(this.tenantId, campaignId),
      this.db.prepare("DELETE FROM events WHERE tenant_id = ? AND campaign_id = ?").bind(this.tenantId, campaignId),
    ]);
  }

  async upsertCampaign(campaign: Campaign, active = true): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO campaigns (tenant_id, campaign_id, platform, media_id, config_json, active, updated_at)
         VALUES (?, ?, 'instagram', ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id) DO UPDATE SET
           media_id = excluded.media_id,
           config_json = excluded.config_json,
           active = excluded.active,
           updated_at = excluded.updated_at`,
      )
      .bind(this.tenantId, campaign.campaign_id, campaign.media_id, JSON.stringify(campaign), active ? 1 : 0, now())
      .run();
  }

  // ---- idempotency ledgers ----

  async isCommentProcessed(commentId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM processed_comments WHERE tenant_id = ? AND comment_id = ?")
      .bind(this.tenantId, commentId)
      .first();
    return row !== null;
  }

  /**
   * Batched form of isCommentProcessed: ONE query per page of comments instead of one per
   * comment. This is the fix for the `exceededCpu` incident (session note
   * `chatmany-poller-cpu-limit`): the engine used to make one D1 round trip per comment, so a
   * 100-comment window across 3 media was ~300 round trips and Cloudflare killed the invocation
   * mid-loop, leaving later commenters silently unserved.
   */
  async processedCommentIds(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await this.db
        .prepare(
          `SELECT comment_id FROM processed_comments WHERE tenant_id = ? AND comment_id IN (${placeholders})`,
        )
        .bind(this.tenantId, ...chunk)
        .all<{ comment_id: string }>();
      for (const r of rows.results ?? []) out.add(r.comment_id);
    }
    return out;
  }

  async markCommentProcessed(commentId: string, igsid: string, campaignId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_comments (tenant_id, comment_id, igsid, campaign_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(this.tenantId, commentId, igsid, campaignId, now())
      .run();
  }

  /**
   * Claim an outbound send before it is attempted. True = this caller owns the send; false = a
   * previous attempt already claimed it and may have delivered, so re-sending would show the
   * recipient the same DM twice.
   */
  async claimSend(key: string): Promise<boolean> {
    const res = await this.db
      .prepare(`INSERT OR IGNORE INTO send_claims (tenant_id, key, created_at) VALUES (?, ?, ?)`)
      .bind(this.tenantId, key, now())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** Release a claim so the send can be retried. Only safe when nothing was delivered. */
  async releaseSend(key: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM send_claims WHERE tenant_id = ? AND key = ?`)
      .bind(this.tenantId, key)
      .run();
  }

  async claimCommentAction(commentId: string, action: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO comment_actions (tenant_id, comment_id, action, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(this.tenantId, commentId, action, now())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // ---- conversations ----

  async getConversation(igsid: string, campaignId: string): Promise<ConversationRow | null> {
    return await this.db
      .prepare("SELECT * FROM conversations WHERE tenant_id = ? AND igsid = ? AND campaign_id = ?")
      .bind(this.tenantId, igsid, campaignId)
      .first<ConversationRow>();
  }

  async getOpenConversations(igsid: string): Promise<ConversationRow[]> {
    const rows = await this.db
      .prepare("SELECT * FROM conversations WHERE tenant_id = ? AND igsid = ? AND state != 'DONE'")
      .bind(this.tenantId, igsid)
      .all<ConversationRow>();
    return rows.results ?? [];
  }

  async createConversation(
    igsid: string,
    campaignId: string,
    username: string | null,
    state: State,
  ): Promise<void> {
    const ts = now();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO conversations
           (tenant_id, igsid, campaign_id, state, username, followed, follow_retries, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .bind(this.tenantId, igsid, campaignId, state, username, ts, ts)
      .run();
  }

  async updateConversation(
    igsid: string,
    campaignId: string,
    patch: Partial<Pick<ConversationRow, "state" | "email" | "followed" | "follow_retries">>,
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      binds.push(patch.state);
    }
    if (patch.email !== undefined) {
      sets.push("email = ?");
      binds.push(patch.email);
    }
    if (patch.followed !== undefined) {
      sets.push("followed = ?");
      binds.push(patch.followed);
    }
    if (patch.follow_retries !== undefined) {
      sets.push("follow_retries = ?");
      binds.push(patch.follow_retries);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    binds.push(now(), this.tenantId, igsid, campaignId);
    await this.db
      .prepare(
        `UPDATE conversations SET ${sets.join(", ")} WHERE tenant_id = ? AND igsid = ? AND campaign_id = ?`,
      )
      .bind(...binds)
      .run();
  }

  async listConversations(campaignId: string | null, limit = 500): Promise<ConversationRow[]> {
    const rows = campaignId
      ? await this.db
          .prepare(
            "SELECT * FROM conversations WHERE tenant_id = ? AND campaign_id = ? ORDER BY updated_at DESC LIMIT ?",
          )
          .bind(this.tenantId, campaignId, limit)
          .all<ConversationRow>()
      : await this.db
          .prepare("SELECT * FROM conversations WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?")
          .bind(this.tenantId, limit)
          .all<ConversationRow>();
    return rows.results ?? [];
  }

  // ---- events ----

  async logEvent(campaignId: string, type: EventType, igsid: string | null): Promise<void> {
    await this.db
      .prepare(`INSERT INTO events (tenant_id, campaign_id, igsid, type, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(this.tenantId, campaignId, igsid, type, now())
      .run();
  }

  /** Batched event writes — one round trip for the 2-3 events a new lead produces. */
  async logEvents(entries: Array<{ campaignId: string; type: EventType; igsid: string | null }>): Promise<void> {
    if (entries.length === 0) return;
    const ts = now();
    await this.db.batch(
      entries.map((e) =>
        this.db
          .prepare(`INSERT INTO events (tenant_id, campaign_id, igsid, type, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(this.tenantId, e.campaignId, e.igsid, e.type, ts),
      ),
    );
  }

  async countEvents(campaignId: string, type: EventType, sinceTs: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE tenant_id = ? AND campaign_id = ? AND type = ? AND created_at >= ?`,
      )
      .bind(this.tenantId, campaignId, type, sinceTs)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * This tenant's count of an event type since a cutoff (the hourly send cap).
   *
   * tenant_id leads idx_events_type_time, so this reads an index range for ONE tenant — it is
   * the query that used to full-scan a shared table every 90s and burn D1's daily read cap.
   */
  async countEventsForTenant(type: EventType, sinceTs: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND type = ? AND created_at >= ?`)
      .bind(this.tenantId, type, sinceTs)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async eventCountsByType(campaignId: string | null, sinceTs: number): Promise<Record<EventType, number>> {
    const base: Record<EventType, number> = {
      comment_matched: 0,
      opening_sent: 0,
      button_clicked: 0,
      follow_confirmed: 0,
      email_captured: 0,
      delivered: 0,
    };
    const rows = campaignId
      ? await this.db
          .prepare(
            `SELECT type, COUNT(*) AS n FROM events
             WHERE tenant_id = ? AND campaign_id = ? AND created_at >= ? GROUP BY type`,
          )
          .bind(this.tenantId, campaignId, sinceTs)
          .all<{ type: EventType; n: number }>()
      : await this.db
          .prepare(
            `SELECT type, COUNT(*) AS n FROM events WHERE tenant_id = ? AND created_at >= ? GROUP BY type`,
          )
          .bind(this.tenantId, sinceTs)
          .all<{ type: EventType; n: number }>();
    for (const r of rows.results ?? []) {
      if (r.type in base) base[r.type] = r.n;
    }
    return base;
  }

  // ---- kv (small runtime state) ----

  async kvGet(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM kv WHERE tenant_id = ? AND key = ?")
      .bind(this.tenantId, key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async kvSet(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO kv (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(this.tenantId, key, value, now())
      .run();
  }

  /**
   * Atomically claim this tenant's poll slot. Returns true only if no other invocation claimed
   * it within `intervalSeconds`. An atomic claim, not a check-then-act read/write: the gap in a
   * read-then-write let two overlapping invocations both pass the "is it due" check and both send
   * a real duplicate DM before either INSERT OR IGNORE could dedup.
   *
   * In hosted mode the tenant's Durable Object is the run lock (one runner per tenant, always) —
   * this stays for the self-host path and as a second belt for /admin/poll.
   */
  async claimPollSlot(intervalSeconds: number): Promise<boolean> {
    const ts = now();
    await this.db
      .prepare(`INSERT OR IGNORE INTO kv (tenant_id, key, value, updated_at) VALUES (?, 'last_poll_ts', '0', ?)`)
      .bind(this.tenantId, ts)
      .run();
    const res = await this.db
      .prepare(
        `UPDATE kv SET value = ?, updated_at = ?
         WHERE tenant_id = ? AND key = 'last_poll_ts' AND CAST(value AS INTEGER) <= ?`,
      )
      .bind(String(ts), ts, this.tenantId, ts - intervalSeconds)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  // ---- metering ledger (UNITS ONLY — never money; see schema/0005) ----

  /** Add metered units for this tenant in the current UTC month. */
  async addUsage(slug: string, units: number, monthKey = utcMonth()): Promise<void> {
    if (units <= 0) return;
    await this.db
      .prepare(
        `INSERT INTO usage_monthly (tenant_id, month, slug, units, reported, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(tenant_id, month, slug) DO UPDATE SET
           units = usage_monthly.units + excluded.units,
           updated_at = excluded.updated_at`,
      )
      .bind(this.tenantId, monthKey, slug, units, now())
      .run();
  }

  /** Mark units publik has acknowledged, so `units - reported` is what is still in flight. */
  async markUsageReported(slug: string, units: number, monthKey = utcMonth()): Promise<void> {
    if (units <= 0) return;
    await this.db
      .prepare(
        `UPDATE usage_monthly SET reported = reported + ?, updated_at = ?
         WHERE tenant_id = ? AND month = ? AND slug = ?`,
      )
      .bind(units, now(), this.tenantId, monthKey, slug)
      .run();
  }

  async usageForMonth(monthKey = utcMonth()): Promise<Array<{ slug: string; units: number; reported: number }>> {
    const rows = await this.db
      .prepare("SELECT slug, units, reported FROM usage_monthly WHERE tenant_id = ? AND month = ?")
      .bind(this.tenantId, monthKey)
      .all<{ slug: string; units: number; reported: number }>();
    return rows.results ?? [];
  }

  // ---- export / erase (one method each, per R30 §3.2) ----

  /** Everything this tenant owns, for the dashboard's export button. */
  async exportAll(): Promise<Record<string, unknown[]>> {
    const tables = ["campaigns", "conversations", "processed_comments", "comment_actions", "events", "usage_monthly"];
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      const rows = await this.db.prepare(`SELECT * FROM ${t} WHERE tenant_id = ?`).bind(this.tenantId).all();
      out[t] = rows.results ?? [];
    }
    return out;
  }

  /** Erase everything this tenant owns (Meta's data-deletion callback). */
  async eraseAll(): Promise<void> {
    const tables = [
      "campaigns",
      "conversations",
      "processed_comments",
      "comment_actions",
      "events",
      "send_claims",
      "kv",
      "usage_monthly",
    ];
    await this.db.batch(
      tables.map((t) => this.db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).bind(this.tenantId)),
    );
  }
}

/** 'YYYY-MM' in UTC — the billing month the operator's rate job groups by. */
export function utcMonth(at: number = now()): string {
  return new Date(at * 1000).toISOString().slice(0, 7);
}
