// Shared types for chatmany.

/** Cloudflare bindings + vars available on the Worker environment. */
export interface Env {
  DB: D1Database;
  /** Static-asset binding serving the web UI from ./public. */
  ASSETS: Fetcher;

  // vars (wrangler.toml [vars])
  GRAPH_VERSION: string;
  MODE: "polling" | "webhook";
  POLL_INTERVAL_SECONDS: string;
  REDIRECT_URI: string;

  // secrets (wrangler secret put ...) — self-host path
  APP_ID: string;
  APP_SECRET: string;
  OWNER_TOKEN: string;
  WEBHOOK_VERIFY_TOKEN?: string;

  // ---- hosted (multi-tenant) mode: absent on a self-host deployment ----
  /** "1" turns on the hosted routes, the per-tenant Durable Objects and the cron fan-out. */
  HOSTED?: string;
  /** Durable Object namespace, one object per tenant. */
  TENANT?: DurableObjectNamespace;
  /** Key-encryption key for per-tenant secrets at rest (>= 32 random characters). */
  TOKEN_KEK?: string;
  /** Previous KEK, kept only while a rotation is in flight. */
  TOKEN_KEK_PREVIOUS?: string;
  /** publik API base, e.g. https://publikhq.com — the metering ingest lives under it. */
  PUBLIK_API_BASE?: string;
  /** Bearer token for POST {PUBLIK_API_BASE}/api/v1/infra/usage. */
  INFRA_INGEST_TOKEN?: string;
  /** Bearer token publik presents to this Worker's /hosted/* control routes. */
  INFRA_ADMIN_TOKEN?: string;
}

/** Env with every hosted binding present. Produced only by `asHosted`. */
export interface HostedEnv extends Env {
  TENANT: DurableObjectNamespace;
  TOKEN_KEK: string;
  PUBLIK_API_BASE: string;
  INFRA_INGEST_TOKEN: string;
  INFRA_ADMIN_TOKEN: string;
}

/** True when this deployment is configured to host other people's accounts. */
export function isHosted(env: Env): boolean {
  return env.HOSTED === "1";
}

/**
 * Narrow to HostedEnv, or return null with a log line naming what is missing. Hosted mode fails
 * closed: a half-configured deployment serves the self-host path rather than handling a creator's
 * traffic without a KEK or without somewhere to report usage.
 */
export function asHosted(env: Env): HostedEnv | null {
  if (!isHosted(env)) return null;
  const missing: string[] = [];
  if (!env.TENANT) missing.push("TENANT (durable object binding)");
  if (!env.TOKEN_KEK) missing.push("TOKEN_KEK");
  if (!env.PUBLIK_API_BASE) missing.push("PUBLIK_API_BASE");
  if (!env.INFRA_INGEST_TOKEN) missing.push("INFRA_INGEST_TOKEN");
  if (!env.INFRA_ADMIN_TOKEN) missing.push("INFRA_ADMIN_TOKEN");
  if (missing.length > 0) {
    console.error(`[chatmany] HOSTED=1 but not configured: ${missing.join(", ")}`);
    return null;
  }
  return env as HostedEnv;
}

/** Funnel state for one person in one campaign. */
export type State =
  | "NEW"
  | "AWAITING_TAP"
  | "AWAITING_FOLLOW"
  | "AWAITING_EMAIL"
  | "DELIVER"
  | "DONE";

/** Analytics event types (mirrors events.type). */
export type EventType =
  | "comment_matched"
  | "opening_sent"
  | "button_clicked"
  | "follow_confirmed"
  | "email_captured"
  | "delivered";

export interface RewardConfig {
  type: "link" | "code" | "text";
  value: string;
}

export interface PublicReplyConfig {
  enabled: boolean;
  texts: string[];
}

export interface RefusalFallbackConfig {
  enabled: boolean;
  /** `{keyword}` is substituted with the campaign's first keyword. */
  text?: string;
}

export interface CampaignCopy {
  opening: string;
  opening_button?: string;
  follow_gate?: string;
  follow_button?: string;
  email_ask?: string;
  delivery: string;
}

/** A single campaign (Section 7). Validated on load. */
export interface Campaign {
  campaign_id: string;
  /** Human-friendly automation name shown in the builder/list (optional). */
  name?: string;
  media_id: string;
  keywords: string[];
  exclude?: string[];
  public_reply?: PublicReplyConfig;
  /**
   * ManyChat parity (live fix, 2026-08-23): ONE plain private reply carrying the delivery text
   * itself, no button to tap. Every ManyChat flow does this, and chatmany's extra tap was a large
   * funnel drop (32 openers -> 2 taps on one migrated campaign). Cannot be combined with
   * check_follow / ask_email, which both need a tap.
   */
  deliver_in_opening?: boolean;
  /**
   * When Instagram permanently refuses the private reply (the commenter does not follow the
   * account), post a public reply asking them to DM the keyword instead — the inbound responder
   * then delivers. Off by default: an unexplained public reply on a viral post is the ghost-reel
   * failure.
   */
  refusal_fallback?: RefusalFallbackConfig;
  /** @deprecated Instagram's API cannot like comments. Accepted for backwards compatibility; ignored. */
  like_comment?: boolean;
  check_follow?: boolean;
  verify_follow_count?: boolean;
  ask_email?: boolean;
  reward: RewardConfig;
  copy: CampaignCopy;
}

/** Top-level config file / import payload (Section 7). */
export interface AppConfig {
  mode?: "polling" | "webhook";
  poll_interval_seconds?: number;
  campaigns: Campaign[];
}

/** Normalized event the engine consumes, regardless of transport (poll or webhook). */
export interface NormalizedComment {
  kind: "comment";
  comment_id: string;
  igsid: string;
  username?: string;
  text: string;
  media_id: string;
  timestamp: number;
}

export interface NormalizedMessage {
  kind: "message";
  igsid: string;
  text?: string;
  /** Postback / quick-reply payload if the transport exposes it (webhooks do; polling may not). */
  payload?: string;
  /** Email captured from a user_email quick-reply chip, if present. */
  email?: string;
  timestamp: number;
}

export type NormalizedEvent = NormalizedComment | NormalizedMessage;

/** Stored auth row. */
export interface AuthRow {
  access_token: string;
  ig_user_id: string | null;
  username: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  expires_at: number;
  refreshed_at: number | null;
}
