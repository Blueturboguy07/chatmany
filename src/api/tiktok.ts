// TikTok API for Business client — Accounts API (organic comments + videos) and Business
// Messaging API (direct messages), both under https://business-api.tiktok.com/open_api/v1.3/.
// Official endpoints only. Every request/response shape here is taken from TikTok's developer
// docs (business-api.tiktok.com/portal/docs, read 2026-09-09) and cross-checked against three
// production integrations of the same endpoints (Chatwoot, python-tiktok, tiktok-business Go SDK).
//
// Ground rules the docs impose and this client encodes:
//   - `business_id` is the `open_id` returned by /tt_user/oauth2/token/ and goes on every call.
//   - Auth header is `Access-Token` (short-term token, valid 1 day; refresh_token valid 1 year).
//   - A DM can only be sent INTO an existing conversation (`recipient_type: CONVERSATION`), i.e.
//     after the person has messaged the Business Account. Up to 10 messages per 48h window.
//   - Comment replies are capped at 150 characters; Q&A card titles at 40, button labels at 20.
//   - Every response is `{ code, message, request_id, data }` with HTTP 200 even on errors —
//     `code !== 0` is the failure signal (40100 = rate limited, 40105 = bad/expired token).

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

/** Error codes the docs list for Business Messaging / Accounts API. */
export const TT_CODE = {
  OK: 0,
  NO_PERMISSION: 40001,
  PARAM_ERROR: 40002,
  NOT_FOUND: 40007,
  DM_BLOCKED: 40064, // outside the 48h window or a cold conversation
  RATE_LIMITED: 40100,
  BAD_TOKEN: 40105,
  SYSTEM_ERROR: 51065,
} as const;

export class TikTokApiError extends Error {
  constructor(
    message: string,
    /** HTTP status of the response (TikTok usually answers 200 even on API errors). */
    readonly status: number,
    /** TikTok's own `code` from the response body, when parseable. */
    readonly code?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "TikTokApiError";
  }
  get isRateLimit(): boolean {
    return this.status === 429 || this.code === TT_CODE.RATE_LIMITED;
  }
  get isBadToken(): boolean {
    return this.status === 401 || this.code === TT_CODE.BAD_TOKEN;
  }
}

interface CommonResponse<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

// ---- shapes we consume ----

export interface TtVideo {
  item_id: string;
  media_type?: "VIDEO" | "PHOTO";
  caption?: string;
  thumbnail_url?: string;
  share_url?: string;
  embed_url?: string;
  create_time?: string | number; // unix seconds, string-encoded per docs
  comments?: number;
  likes?: number;
  video_views?: number;
}

export interface TtComment {
  comment_id: string;
  video_id?: string;
  create_time?: string | number; // unix seconds, string-encoded
  text?: string;
  status?: "PUBLIC" | "HIDDEN";
  username?: string;
  display_name?: string;
  /** Stable cross-API id of the commenter — the same id a DM from them carries as from_user.id. */
  unique_identifier?: string;
  user_id?: string; // deprecated per docs; unique_identifier is preferred
  parent_comment_id?: string;
  owner?: boolean;
}

export interface TtConversation {
  conversation_id: string;
  update_time?: number; // unix ms
}

export interface TtMessage {
  message_id: string;
  conversation_id?: string;
  timestamp?: number; // unix ms
  message_type?: string;
  from_user?: { role?: string; id?: string };
  to_user?: { role?: string; id?: string };
  text?: { body?: string };
  template?: { type?: string; title?: string; buttons?: { title?: string; id?: string }[] };
}

export interface TtParticipant {
  role?: "BUSINESS_ACCOUNT" | "PERSONAL_ACCOUNT";
  id?: string;
  display_name?: string;
  is_follower?: boolean;
}

export interface TtProfile {
  username?: string;
  display_name?: string;
  profile_image?: string;
}

export interface QaButton {
  /** Shown on the card and echoed back as the person's reply text when tapped. ≤20 chars. */
  title: string;
  /** Self-defined id, surfaced on the inbound webhook as reply_source_payload.reply_source_unique_id. ≤40 chars. */
  id: string;
}

export const COMMENT_REPLY_MAX = 150;
export const QA_TITLE_MAX = 40;
export const QA_BUTTON_MAX = 20;

export class TikTokClient {
  constructor(
    private readonly accessToken: string,
    /** open_id of the connected Business Account (business_id on every call). */
    readonly businessId: string,
  ) {}

  // ---- transport ----

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { method: "GET", headers: { "Access-Token": this.accessToken } });
    return this.parse<T>(res, path);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Access-Token": this.accessToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res, path);
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let json: CommonResponse<T> | undefined;
    try {
      json = JSON.parse(text) as CommonResponse<T>;
    } catch {
      throw new TikTokApiError(`TikTok ${path}: HTTP ${res.status} (unparseable body: ${text.slice(0, 200)})`, res.status);
    }
    if (!res.ok || json.code !== TT_CODE.OK) {
      throw new TikTokApiError(
        `TikTok ${path}: code ${json.code} ${json.message ?? ""} (request_id ${json.request_id ?? "?"})`.trim(),
        res.status,
        json.code,
        json.request_id,
      );
    }
    return (json.data ?? {}) as T;
  }

  // ---- Accounts API: account + videos ----

  /** GET /business/get/ — username, display name, avatar of the connected account. */
  getProfile(): Promise<TtProfile> {
    return this.get<TtProfile>("/business/get/", {
      business_id: this.businessId,
      fields: JSON.stringify(["username", "display_name", "profile_image"]),
    });
  }

  /** GET /business/video/list/ — the account's own posts, newest first (max_count ≤ 20 per page). */
  async listVideos(maxCount = 20): Promise<TtVideo[]> {
    const data = await this.get<{ videos?: TtVideo[]; has_more?: boolean; cursor?: number }>("/business/video/list/", {
      business_id: this.businessId,
      fields: JSON.stringify(["item_id", "media_type", "caption", "thumbnail_url", "share_url", "create_time", "comments", "likes", "video_views"]),
      max_count: String(Math.min(20, Math.max(1, maxCount))),
    });
    return data.videos ?? [];
  }

  // ---- Accounts API: comments ----

  /** GET /business/comment/list/ — top-level comments on an owned video, newest first (max_count ≤ 30). */
  async listComments(videoId: string, maxCount = 30, cursor?: number): Promise<{ comments: TtComment[]; hasMore: boolean; cursor?: number }> {
    const params: Record<string, string> = {
      business_id: this.businessId,
      video_id: videoId,
      status: "ALL",
      sort_field: "create_time",
      sort_type: "desc",
      max_count: String(Math.min(30, Math.max(1, maxCount))),
    };
    if (cursor !== undefined) params.cursor = String(cursor);
    const data = await this.get<{ comments?: TtComment[]; has_more?: boolean; cursor?: number }>("/business/comment/list/", params);
    return { comments: data.comments ?? [], hasMore: Boolean(data.has_more), cursor: data.cursor };
  }

  /** GET /business/comment/list/ with comment_ids — fetch specific comments (≤30) by id, e.g. after a comment.update webhook. */
  async getComments(videoId: string, commentIds: string[]): Promise<TtComment[]> {
    if (commentIds.length === 0) return [];
    const data = await this.get<{ comments?: TtComment[] }>("/business/comment/list/", {
      business_id: this.businessId,
      video_id: videoId,
      comment_ids: JSON.stringify(commentIds.slice(0, 30)),
      status: "ALL",
    });
    return data.comments ?? [];
  }

  /** POST /business/comment/reply/create/ — public reply under a comment (≤150 chars). */
  replyToComment(videoId: string, commentId: string, text: string): Promise<{ comment_id?: string }> {
    return this.post("/business/comment/reply/create/", {
      business_id: this.businessId,
      video_id: videoId,
      comment_id: commentId,
      text: clip(text, COMMENT_REPLY_MAX),
    });
  }

  // ---- Business Messaging API ----

  /** POST /business/message/send/ — plain text into an existing conversation (≤6000 chars). */
  sendText(conversationId: string, body: string): Promise<{ message?: { message_id?: string } }> {
    return this.post("/business/message/send/", {
      business_id: this.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "TEXT",
      text: { body },
    });
  }

  /**
   * POST /business/message/send/ — a Q&A button card: a question (≤40 chars) with 1–3 REPLY buttons
   * (≤20 chars each). Tapping a button sends its label back as the person's message, and the
   * inbound webhook carries our button `id` in reply_source_payload.reply_source_unique_id.
   */
  sendQaButtons(conversationId: string, title: string, buttons: QaButton[]): Promise<{ message?: { message_id?: string } }> {
    return this.post("/business/message/send/", {
      business_id: this.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "TEMPLATE",
      template: {
        type: "QA_BUTTON_CARD",
        title: clip(title, QA_TITLE_MAX),
        buttons: buttons.slice(0, 3).map((b) => ({ type: "REPLY", title: clip(b.title, QA_BUTTON_MAX), id: clip(b.id, 40) })),
      },
    });
  }

  /** GET /business/message/conversation/list/ — STRANGER (they wrote, we never replied) or SINGLE (we replied). Past 90 days, ≤100. */
  async listConversations(type: "STRANGER" | "SINGLE", limit = 100): Promise<TtConversation[]> {
    const data = await this.get<{ conversations?: TtConversation[] }>("/business/message/conversation/list/", {
      business_id: this.businessId,
      conversation_type: type,
      limit: String(Math.min(100, Math.max(1, limit))),
    });
    return data.conversations ?? [];
  }

  /** GET /business/message/content/list/ — the 20 most recent messages of a conversation + participants. */
  async listMessages(conversationId: string): Promise<{ messages: TtMessage[]; participants: TtParticipant[] }> {
    const data = await this.get<{ messages?: TtMessage[]; participants?: TtParticipant[] }>("/business/message/content/list/", {
      business_id: this.businessId,
      conversation_id: conversationId, // URLSearchParams encodes '+' as %2B, which the docs require
    });
    return { messages: data.messages ?? [], participants: data.participants ?? [] };
  }
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

// ---- OAuth (TikTok account holder authorization) ----

/** Scopes chatmany asks for: read own profile + posts, read/reply comments, read/send DMs. */
export const TIKTOK_SCOPES = [
  "user.info.basic",
  "user.info.username",
  "user.account.type",
  "video.list",
  "comment.list",
  "comment.list.manage",
  "message.list.read",
  "message.list.send",
  "message.list.manage",
];

/** The "TikTok account holder authorization URL" shape from the developer portal. */
export function buildTikTokAuthorizeUrl(appId: string, redirectUri: string, state: string, scopes = TIKTOK_SCOPES): string {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize");
  url.searchParams.set("client_key", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TikTokTokenData {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in: number; // seconds (~1 day)
  refresh_token: string;
  refresh_token_expires_in: number; // seconds (~1 year)
  open_id: string;
}

async function tokenCall(path: string, body: Record<string, string>): Promise<TikTokTokenData> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: CommonResponse<TikTokTokenData>;
  try {
    json = JSON.parse(text) as CommonResponse<TikTokTokenData>;
  } catch {
    throw new TikTokApiError(`TikTok ${path}: HTTP ${res.status} (unparseable body)`, res.status);
  }
  if (!res.ok || json.code !== TT_CODE.OK || !json.data?.access_token) {
    throw new TikTokApiError(`TikTok ${path}: code ${json.code} ${json.message ?? ""}`.trim(), res.status, json.code, json.request_id);
  }
  return json.data;
}

/** POST /tt_user/oauth2/token/ — exchange the callback's `code` (valid 10 min, single-use). */
export function exchangeTikTokCode(appId: string, appSecret: string, redirectUri: string, code: string): Promise<TikTokTokenData> {
  return tokenCall("/tt_user/oauth2/token/", {
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    auth_code: code,
    redirect_uri: redirectUri,
  });
}

/** POST /tt_user/oauth2/refresh_token/ — roll the 1-day access token using the 1-year refresh token. */
export function refreshTikTokToken(appId: string, appSecret: string, refreshToken: string): Promise<TikTokTokenData> {
  return tokenCall("/tt_user/oauth2/refresh_token/", {
    client_id: appId,
    client_secret: appSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// ---- Webhook subscriptions (app-level; authenticated with app id + secret, no user token) ----

export type TikTokWebhookEventType = "DIRECT_MESSAGE" | "COMMENT" | "VIDEO" | "BRAND_MENTION";

async function appCall<T>(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<T> {
  let res: Response;
  if (method === "GET") {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  } else {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(params),
    });
  }
  const text = await res.text();
  let json: CommonResponse<T>;
  try {
    json = JSON.parse(text) as CommonResponse<T>;
  } catch {
    throw new TikTokApiError(`TikTok ${path}: HTTP ${res.status} (unparseable body)`, res.status);
  }
  if (!res.ok || json.code !== TT_CODE.OK) {
    throw new TikTokApiError(`TikTok ${path}: code ${json.code} ${json.message ?? ""}`.trim(), res.status, json.code, json.request_id);
  }
  return (json.data ?? {}) as T;
}

/** POST /business/webhook/update/ — subscribe the developer app to an event type. `itemList` scopes COMMENT to specific videos. */
export function subscribeTikTokWebhook(
  appId: string,
  appSecret: string,
  eventType: TikTokWebhookEventType,
  callbackUrl: string,
  itemList?: string[],
): Promise<{ app_id?: string; event_type?: string; callback_url?: string; item_list?: string[] }> {
  const body: Record<string, unknown> = { app_id: appId, secret: appSecret, event_type: eventType, callback_url: callbackUrl };
  if (eventType === "COMMENT" && itemList && itemList.length > 0) body.item_list = itemList;
  return appCall("POST", "/business/webhook/update/", body);
}

/** GET /business/webhook/list/ — what TikTok has stored for an event type (no callback_url ⇒ not subscribed). */
export function getTikTokWebhook(
  appId: string,
  appSecret: string,
  eventType: TikTokWebhookEventType,
): Promise<{ app_id?: string; event_type?: string; callback_url?: string; item_list?: string[] }> {
  return appCall("GET", "/business/webhook/list/", { app_id: appId, secret: appSecret, event_type: eventType });
}
