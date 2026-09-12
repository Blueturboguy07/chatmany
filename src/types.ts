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

  // secrets (wrangler secret put ...)
  APP_ID: string;
  APP_SECRET: string;
  OWNER_TOKEN: string;
  WEBHOOK_VERIFY_TOKEN?: string;

  // TikTok (optional — the TikTok routes answer with a clear error until these exist)
  /** Developer app ID from business-api.tiktok.com → My Apps → Basic Information. */
  TIKTOK_APP_ID?: string;
  /** Developer app secret (also signs webhook deliveries). */
  TIKTOK_APP_SECRET?: string;
  /** Must match the "TikTok account holder redirect URL" registered on the app: https://<worker>/auth/tiktok/callback */
  TIKTOK_REDIRECT_URI?: string;
  /** "webhook" (default; comments + DMs arrive by push) or "polling" (the minute cron reads comments + conversations). */
  TIKTOK_MODE?: "webhook" | "polling";
}

/** Which network a campaign runs on. Stored in campaigns.platform and in the campaign config. */
export type Platform = "instagram" | "tiktok";

/** Funnel state for one person in one campaign. */
export type State =
  | "NEW"
  | "AWAITING_TAP"
  /** TikTok only: we replied publicly under their comment and are waiting for them to DM the keyword. */
  | "AWAITING_DM"
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
  /** Defaults to "instagram" for every campaign that predates TikTok support. */
  platform?: Platform;
  /** Human-friendly automation name shown in the builder/list (optional). */
  name?: string;
  media_id: string;
  keywords: string[];
  exclude?: string[];
  public_reply?: PublicReplyConfig;
  /** @deprecated Instagram's API cannot like comments. Accepted for backwards compatibility; ignored. */
  like_comment?: boolean;
  check_follow?: boolean;
  verify_follow_count?: boolean;
  ask_email?: boolean;
  /**
   * Send the reward straight back in the private reply to the comment — one plain-text message,
   * no button to tap (this is how ManyChat's "Auto-DM links from comments" behaves). The person
   * gets `copy.delivery` (with {reward} substituted) immediately and the conversation is DONE.
   * Incompatible with check_follow / ask_email, which need the tap flow to gather a response.
   */
  deliver_in_opening?: boolean;
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
  /** Instagram: the commenter's IGSID. TikTok: the commenter's unique_identifier (the same id their DMs carry). */
  igsid: string;
  username?: string;
  text: string;
  media_id: string;
  timestamp: number;
}

export interface NormalizedMessage {
  kind: "message";
  /** Instagram: sender IGSID. TikTok: sender unique_identifier. */
  igsid: string;
  text?: string;
  /** Postback / quick-reply payload if the transport exposes it (webhooks do; polling may not). */
  payload?: string;
  /** Email captured from a user_email quick-reply chip, if present. */
  email?: string;
  timestamp: number;
  /** TikTok: the conversation a reply must be sent into. Absent on Instagram. */
  conversation_id?: string;
  /** TikTok: whether the sender follows the Business Account, as reported by the webhook/content list. */
  is_follower?: boolean;
  /** TikTok: the sender's @username when known. */
  username?: string;
  /** TikTok: the inbound message id (dedup key for re-deliveries). */
  message_id?: string;
}

export type NormalizedEvent = NormalizedComment | NormalizedMessage;

/** Stored auth row. */
/** Stored TikTok auth row (tiktok_auth table). */
export interface TikTokAuthRow {
  access_token: string;
  refresh_token: string;
  business_id: string;
  username: string | null;
  display_name: string | null;
  profile_image: string | null;
  scope: string | null;
  expires_at: number;
  refresh_expires_at: number;
  refreshed_at: number | null;
}

export interface AuthRow {
  access_token: string;
  ig_user_id: string | null;
  username: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  expires_at: number;
  refreshed_at: number | null;
}
