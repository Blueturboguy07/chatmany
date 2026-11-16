// Copied from publik lib/chatmany-hosted/types.ts (the web page's code). Keep the two in step.
/**
 * The shapes the hosted chatmany service answers with, as publik reads them.
 *
 * The `/api/*` payloads are the self-host API's, unchanged: chatmany's
 * src/routes/api.ts (status, media, campaigns, dashboard, contacts),
 * src/types.ts (`Campaign`) and src/api/client.ts (`IgMedia`). The tenant
 * view is the control plane's `publicView`. Nothing here is server-only: the
 * page's client components read the same shapes through publik's proxy.
 */

/** The control plane's view of one creator's tenant. Never holds a token. */
export interface TenantView {
  tenant_id: string;
  publik_user_id: string | null;
  ig_user_id: string | null;
  username: string | null;
  mode: string | null;
  status: string | null;
  paused_reason: string | null;
  webhook_verified: boolean | null;
  token_expires_at: number | null;
  created_at: number | null;
}

export type StatusView = { connected: false } | ConnectedStatus;

export interface ConnectedStatus {
  connected: true;
  username: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  ig_user_id: string | null;
  /** Unix seconds. */
  expires_at: number;
  expires_in_days: number;
  token_expired: boolean;
}

/** One of the account's posts or reels (Instagram's media object, the fields chatmany asks for). */
export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export interface CampaignCopy {
  opening: string;
  opening_button?: string;
  follow_gate?: string;
  follow_button?: string;
  email_ask?: string;
  delivery: string;
}

/** chatmany's `Campaign`, which the service validates on every save. */
export interface Campaign {
  campaign_id: string;
  name?: string;
  media_id: string;
  keywords: string[];
  exclude?: string[];
  public_reply?: { enabled: boolean; texts: string[] };
  deliver_in_opening?: boolean;
  refusal_fallback?: { enabled: boolean; text?: string };
  like_comment?: boolean;
  check_follow?: boolean;
  verify_follow_count?: boolean;
  ask_email?: boolean;
  reward: { type: "link" | "code" | "text"; value: string };
  copy: CampaignCopy;
}

/** A campaign as the list returns it: the campaign plus its switches. */
export interface CampaignRow extends Campaign {
  active: boolean;
  archived: boolean;
  /** Unix seconds. */
  updated_at: number;
}

export interface DashboardView {
  campaign_id: string | null;
  days: number;
  cards: {
    comments: number;
    sends: number;
    clicks: number;
    ctr: number;
    follows: number;
    emails: number;
    delivered: number;
  };
  funnel: Array<{ label: string; value: number; pct: number }>;
}

export interface ContactView {
  igsid: string;
  username: string | null;
  campaign_id: string;
  state: string;
  status_label: string;
  followed: boolean;
  email: string | null;
  /** Unix seconds. */
  updated_at: number;
}
