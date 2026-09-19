// D1 data-access for the SELF-HOST path (R30 D6 — still supported, unchanged behaviour).
//
// These are thin delegates onto TenantDb bound to the reserved tenant id 'self'. There is exactly
// one SQL surface in this repo (src/tenant/db.ts) so the self-host and hosted paths can never
// drift, and so every self-host query also hits a tenant_id-prefixed index.
//
// All timestamps are unix seconds. Kept intentionally thin so the engine stays readable and cron
// ticks do minimal work.

import type { AuthRow, Campaign, EventType, State } from "./types";
import { SELF_TENANT, TenantDb, now } from "./tenant/db";
import type { CampaignListItem, ConversationRow } from "./tenant/db";

export { now, SELF_TENANT };
export type { CampaignListItem, ConversationRow };

/** The self-host tenant's data accessor. */
function self(db: D1Database): TenantDb {
  return new TenantDb(db, SELF_TENANT);
}

// ---- campaigns ----

export interface StoredCampaign {
  campaign: Campaign;
  active: boolean;
}

/** Active campaigns only. An archived campaign is never polled even if `active` is still on. */
export function getActiveCampaigns(db: D1Database): Promise<Campaign[]> {
  return self(db).getActiveCampaigns();
}

export function getCampaign(db: D1Database, campaignId: string): Promise<Campaign | null> {
  return self(db).getCampaign(campaignId);
}

/** Campaigns for the builder list; `{ archived: true }` returns the Archive tab's contents. */
export function getAllCampaigns(
  db: D1Database,
  opts: { archived?: boolean } = {},
): Promise<CampaignListItem[]> {
  return self(db).getAllCampaigns(opts);
}

export function setCampaignActive(db: D1Database, campaignId: string, active: boolean): Promise<void> {
  return self(db).setCampaignActive(campaignId, active);
}

/** Archive (soft-delete) or restore. Archiving keeps history but stops polling. */
export function setCampaignArchived(db: D1Database, campaignId: string, archived: boolean): Promise<void> {
  return self(db).setCampaignArchived(campaignId, archived);
}

/** Delete a campaign and all of its history (permanent — see TenantDb.deleteCampaign). */
export function deleteCampaign(db: D1Database, campaignId: string): Promise<void> {
  return self(db).deleteCampaign(campaignId);
}

export function upsertCampaign(db: D1Database, campaign: Campaign, active = true): Promise<void> {
  return self(db).upsertCampaign(campaign, active);
}

// ---- idempotency ledgers ----

export function isCommentProcessed(db: D1Database, commentId: string): Promise<boolean> {
  return self(db).isCommentProcessed(commentId);
}

/** Batched lookup — one query per 100 ids (the `exceededCpu` fix). */
export function processedCommentIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  return self(db).processedCommentIds(ids);
}

export function markCommentProcessed(
  db: D1Database,
  commentId: string,
  igsid: string,
  campaignId: string,
): Promise<void> {
  return self(db).markCommentProcessed(commentId, igsid, campaignId);
}

/** Claim an outbound send before it is attempted (at-most-once guard). */
export function claimSend(db: D1Database, key: string): Promise<boolean> {
  return self(db).claimSend(key);
}

/** Release a claim so the send can be retried. Only safe when nothing was delivered. */
export function releaseSend(db: D1Database, key: string): Promise<void> {
  return self(db).releaseSend(key);
}

export function claimCommentAction(db: D1Database, commentId: string, action: string): Promise<boolean> {
  return self(db).claimCommentAction(commentId, action);
}

// ---- conversations ----

export function getConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
): Promise<ConversationRow | null> {
  return self(db).getConversation(igsid, campaignId);
}

/** All non-terminal conversations for a person (a message may advance any of them). */
export function getOpenConversations(db: D1Database, igsid: string): Promise<ConversationRow[]> {
  return self(db).getOpenConversations(igsid);
}

export function createConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
  username: string | null,
  state: State,
): Promise<void> {
  return self(db).createConversation(igsid, campaignId, username, state);
}

export function updateConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
  patch: Partial<Pick<ConversationRow, "state" | "email" | "followed" | "follow_retries">>,
): Promise<void> {
  return self(db).updateConversation(igsid, campaignId, patch);
}

/** People who entered any campaign (Contacts page). */
export function listConversations(
  db: D1Database,
  campaignId: string | null,
  limit = 500,
): Promise<ConversationRow[]> {
  return self(db).listConversations(campaignId, limit);
}

// ---- events ----

export function logEvent(
  db: D1Database,
  campaignId: string,
  type: EventType,
  igsid: string | null,
): Promise<void> {
  return self(db).logEvent(campaignId, type, igsid);
}

/** Batched event writes — one round trip for a new lead's 2-3 events. */
export function logEvents(
  db: D1Database,
  entries: Array<{ campaignId: string; type: EventType; igsid: string | null }>,
): Promise<void> {
  return self(db).logEvents(entries);
}

export function countEvents(
  db: D1Database,
  campaignId: string,
  type: EventType,
  sinceTs: number,
): Promise<number> {
  return self(db).countEvents(campaignId, type, sinceTs);
}

/**
 * Account-wide count of an event type since a cutoff (the global send cap).
 *
 * Scoped to the 'self' tenant so it reads an index range rather than full-scanning a table that
 * may now hold other tenants' rows — the 2026-09-01 D1 daily-read-cap outage was this query
 * without a matching index prefix.
 */
export function countEventsGlobal(db: D1Database, type: EventType, sinceTs: number): Promise<number> {
  return self(db).countEventsForTenant(type, sinceTs);
}

export function eventCountsByType(
  db: D1Database,
  campaignId: string | null,
  sinceTs: number,
): Promise<Record<EventType, number>> {
  return self(db).eventCountsByType(campaignId, sinceTs);
}

// ---- kv (small runtime state) ----

export function kvGet(db: D1Database, key: string): Promise<string | null> {
  return self(db).kvGet(key);
}

export function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  return self(db).kvSet(key, value);
}

/** Atomically claim the poll slot (see TenantDb.claimPollSlot for why it is atomic). */
export function claimPollSlot(db: D1Database, intervalSeconds: number): Promise<boolean> {
  return self(db).claimPollSlot(intervalSeconds);
}

// ---- auth (self-host only: one owner, one token, no KEK) ----
//
// The hosted path never touches this table. Its tokens live in `tenants.meta_token_encrypted`,
// AES-256-GCM with a Worker-secret KEK (src/tenant/crypto.ts), because one Worker holds N
// creators' tokens there.

export async function getAuth(db: D1Database): Promise<AuthRow | null> {
  return await db.prepare("SELECT * FROM auth WHERE id = 1").first<AuthRow>();
}

export async function saveAuth(
  db: D1Database,
  fields: {
    access_token: string;
    expires_at: number;
    ig_user_id?: string | null;
    username?: string | null;
    account_type?: string | null;
    profile_picture_url?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth (id, access_token, ig_user_id, username, account_type, profile_picture_url, expires_at, refreshed_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         ig_user_id = COALESCE(excluded.ig_user_id, auth.ig_user_id),
         username = COALESCE(excluded.username, auth.username),
         account_type = COALESCE(excluded.account_type, auth.account_type),
         profile_picture_url = COALESCE(excluded.profile_picture_url, auth.profile_picture_url),
         expires_at = excluded.expires_at,
         refreshed_at = excluded.refreshed_at`,
    )
    .bind(
      fields.access_token,
      fields.ig_user_id ?? null,
      fields.username ?? null,
      fields.account_type ?? null,
      fields.profile_picture_url ?? null,
      fields.expires_at,
      now(),
    )
    .run();
}

export async function clearAuth(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM auth WHERE id = 1").run();
}
