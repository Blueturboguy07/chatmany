// The `tenants` table: one row per hosted creator. Registry reads/writes only — a tenant's
// campaign and conversation data goes through TenantDb, and its secrets are never returned in
// plaintext from here (see accessors at the bottom, which decrypt for one call site at a time).

import { decryptSecret, encryptSecret, randomToken } from "./crypto";
import { now } from "./db";
import type { HostedEnv } from "../types";

export type TenantMode = "webhook" | "polling";
export type TenantStatus = "connecting" | "active" | "paused_credit" | "paused_meta" | "disconnected";

export interface TenantRow {
  tenant_id: string;
  publik_user_id: string | null;
  publik_install_id: string | null;
  ig_user_id: string | null;
  username: string | null;
  account_type: string | null;
  meta_app_kind: "creator" | "publik";
  meta_app_id: string | null;
  meta_app_secret_enc: string | null;
  meta_token_encrypted: string | null;
  meta_token_expires_at: number | null;
  token_refreshed_at: number | null;
  webhook_verify_token: string | null;
  webhook_verified_at: number | null;
  mode: TenantMode;
  status: TenantStatus;
  paused_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** What the publik dashboard may see. No ciphertext, no token, no app secret. */
export interface TenantPublicView {
  tenant_id: string;
  publik_user_id: string | null;
  ig_user_id: string | null;
  username: string | null;
  mode: TenantMode;
  status: TenantStatus;
  paused_reason: string | null;
  webhook_verified: boolean;
  token_expires_at: number | null;
  created_at: number;
}

export function publicView(t: TenantRow): TenantPublicView {
  return {
    tenant_id: t.tenant_id,
    publik_user_id: t.publik_user_id,
    ig_user_id: t.ig_user_id,
    username: t.username,
    mode: t.mode,
    status: t.status,
    paused_reason: t.paused_reason,
    webhook_verified: t.webhook_verified_at != null,
    token_expires_at: t.meta_token_expires_at,
    created_at: t.created_at,
  };
}

export interface CreateTenantInput {
  publik_user_id?: string | null;
  publik_install_id?: string | null;
  meta_app_kind?: "creator" | "publik";
  meta_app_id?: string | null;
  /** Path L: the creator's own Instagram app secret. Encrypted here, never stored in the clear. */
  meta_app_secret?: string | null;
}

/**
 * Create a tenant. The webhook verify token is generated here and shown to the creator exactly
 * once (they paste it into their own Meta app's Webhooks form); it is what makes the per-tenant
 * GET /webhook/{tenant} handshake meaningful.
 */
export async function createTenant(
  env: HostedEnv,
  input: CreateTenantInput,
): Promise<{ tenant: TenantRow; webhook_verify_token: string }> {
  const tenantId = `t_${randomToken(8)}`;
  const verifyToken = randomToken(24);
  const ts = now();
  const appSecretEnc = input.meta_app_secret
    ? await encryptSecret(env.TOKEN_KEK, tenantId, input.meta_app_secret)
    : null;
  await env.DB.prepare(
    `INSERT INTO tenants
       (tenant_id, publik_user_id, publik_install_id, meta_app_kind, meta_app_id, meta_app_secret_enc,
        webhook_verify_token, mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'polling', 'connecting', ?, ?)`,
  )
    .bind(
      tenantId,
      input.publik_user_id ?? null,
      input.publik_install_id ?? null,
      input.meta_app_kind ?? "creator",
      input.meta_app_id ?? null,
      appSecretEnc,
      verifyToken,
      ts,
      ts,
    )
    .run();
  const tenant = await getTenant(env.DB, tenantId);
  if (!tenant) throw new Error("tenant insert did not land");
  return { tenant, webhook_verify_token: verifyToken };
}

export async function getTenant(db: D1Database, tenantId: string): Promise<TenantRow | null> {
  return await db.prepare("SELECT * FROM tenants WHERE tenant_id = ?").bind(tenantId).first<TenantRow>();
}

/** Path T routing: one shared webhook URL, entries routed by the IG user id they name. */
export async function getTenantByIgUser(db: D1Database, igUserId: string): Promise<TenantRow | null> {
  return await db.prepare("SELECT * FROM tenants WHERE ig_user_id = ?").bind(igUserId).first<TenantRow>();
}

/** Tenants the cron re-arms alarms for: one indexed read, no per-tenant work inline. */
export async function listTenantsForTick(
  db: D1Database,
  mode: TenantMode,
  limit = 200,
): Promise<Array<{ tenant_id: string }>> {
  const rows = await db
    .prepare(
      `SELECT tenant_id FROM tenants
       WHERE mode = ? AND status IN ('active','paused_credit') ORDER BY tenant_id LIMIT ?`,
    )
    .bind(mode, limit)
    .all<{ tenant_id: string }>();
  return rows.results ?? [];
}

export async function listTenants(db: D1Database, limit = 500): Promise<TenantRow[]> {
  const rows = await db
    .prepare("SELECT * FROM tenants ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<TenantRow>();
  return rows.results ?? [];
}

export async function patchTenant(
  db: D1Database,
  tenantId: string,
  patch: Partial<
    Pick<
      TenantRow,
      | "publik_user_id"
      | "publik_install_id"
      | "ig_user_id"
      | "username"
      | "account_type"
      | "meta_app_id"
      | "meta_app_secret_enc"
      | "meta_token_encrypted"
      | "meta_token_expires_at"
      | "token_refreshed_at"
      | "webhook_verified_at"
      | "mode"
      | "status"
      | "paused_reason"
    >
  >,
): Promise<void> {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = ?`).join(", ");
  const binds = cols.map((c) => (patch as Record<string, unknown>)[c]);
  await db
    .prepare(`UPDATE tenants SET ${sets}, updated_at = ? WHERE tenant_id = ?`)
    .bind(...binds, now(), tenantId)
    .run();
}

/** Store a freshly issued Instagram token, encrypted under the tenant's own AAD. */
export async function saveTenantToken(
  env: HostedEnv,
  tenantId: string,
  token: string,
  expiresAt: number,
): Promise<void> {
  const enc = await encryptSecret(env.TOKEN_KEK, tenantId, token);
  await patchTenant(env.DB, tenantId, {
    meta_token_encrypted: enc,
    meta_token_expires_at: expiresAt,
    token_refreshed_at: now(),
  });
}

export async function saveTenantAppSecret(env: HostedEnv, tenantId: string, secret: string): Promise<void> {
  const enc = await encryptSecret(env.TOKEN_KEK, tenantId, secret);
  await patchTenant(env.DB, tenantId, { meta_app_secret_enc: enc });
}

export async function deleteTenant(db: D1Database, tenantId: string): Promise<void> {
  await db.prepare("DELETE FROM tenants WHERE tenant_id = ?").bind(tenantId).run();
}

// ---- secret accessors (the only two functions that produce plaintext) ----

function keks(env: HostedEnv): string[] {
  return [env.TOKEN_KEK, env.TOKEN_KEK_PREVIOUS ?? ""].filter(Boolean);
}

export async function tenantAccessToken(env: HostedEnv, tenant: TenantRow): Promise<string | null> {
  if (!tenant.meta_token_encrypted) return null;
  return await decryptSecret(keks(env), tenant.tenant_id, tenant.meta_token_encrypted);
}

export async function tenantAppSecret(env: HostedEnv, tenant: TenantRow): Promise<string | null> {
  if (!tenant.meta_app_secret_enc) return null;
  return await decryptSecret(keks(env), tenant.tenant_id, tenant.meta_app_secret_enc);
}
