// TikTok webhook receiver (POST /webhook/tiktok). TikTok pushes every event for the developer
// app to ONE callback URL with the same envelope:
//   { client_key, event, create_time, user_openid, content: "<stringified JSON>" }
// (docs: "Subscribe to Business Messaging Webhook events via Webhooks API" + "Comment update
// event", read 2026-09-09). Two event families matter here:
//   - comment.update  (event_type COMMENT)        → a comment was created/deleted/hidden on an owned post
//   - im_receive_msg  (event_type DIRECT_MESSAGE) → a personal account sent the Business Account a DM
// Deliveries are signed: header `Tiktok-Signature: t=<unix seconds>,s=<hex hmac>` where the HMAC
// is SHA-256 over `${t}.${rawBody}` keyed with the app secret (as implemented by Chatwoot's
// production receiver for this exact API). Unsigned or stale deliveries are rejected.

import { buildTikTokRuntime } from "../tiktokRuntime";
import { now } from "../db";
import type { Env, NormalizedComment, NormalizedMessage } from "../types";
import { json } from "./http";

/** How far a delivery's `t` may drift from our clock before it is treated as a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface TikTokEnvelope {
  client_key?: string;
  event?: string;
  create_time?: number;
  user_openid?: string;
  content?: string;
}

/** GET /webhook/tiktok — nothing to verify by handshake (subscriptions are made by API), but answer politely. */
export function handleTikTokWebhookVerify(url: URL): Response {
  const challenge = url.searchParams.get("challenge");
  return new Response(challenge ?? "ok", { status: 200, headers: { "content-type": "text/plain" } });
}

/** POST /webhook/tiktok — verify the signature, normalize the event, hand it to the engine. */
export async function handleTikTokWebhookEvent(env: Env, req: Request): Promise<Response> {
  if (!env.TIKTOK_APP_SECRET) return json({ error: "TIKTOK_APP_SECRET not configured" }, 503);

  const raw = await req.text();
  const sig = req.headers.get("tiktok-signature");
  if (!(await verifyTikTokSignature(env.TIKTOK_APP_SECRET, raw, sig, now()))) {
    return new Response("invalid signature", { status: 401 });
  }

  let envelope: TikTokEnvelope;
  try {
    envelope = JSON.parse(raw) as TikTokEnvelope;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (env.TIKTOK_APP_ID && envelope.client_key && envelope.client_key !== env.TIKTOK_APP_ID) {
    return json({ ok: true, ignored: "other app" });
  }

  const normalized = normalizeTikTokEvent(envelope);
  if (normalized.kind === "ignored") return json({ ok: true, ignored: normalized.reason });

  const rt = await buildTikTokRuntime(env);
  if (!rt) return json({ ok: true, note: "no TikTok account connected" });
  if (envelope.user_openid && envelope.user_openid !== rt.businessId) {
    return json({ ok: true, ignored: "other business account" });
  }

  try {
    if (normalized.kind === "comment") {
      let evt = normalized.event;
      // comment.update carries ids + text; if text or the commenter id is missing, read the comment back.
      if (!evt.text || !evt.igsid || !evt.username) {
        try {
          const [c] = await rt.client.getComments(evt.media_id, [evt.comment_id]);
          if (c) {
            evt = {
              ...evt,
              text: evt.text || c.text || "",
              igsid: evt.igsid || c.unique_identifier || c.user_id || "",
              username: evt.username ?? c.username,
            };
            if (c.owner) return json({ ok: true, ignored: "own comment" });
          }
        } catch (e) {
          console.warn(`[chatmany:tiktok] comment read-back failed for ${evt.comment_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!evt.igsid) return json({ ok: true, ignored: "no commenter id" });
      await rt.engine.handleComment(evt);
    } else {
      await rt.engine.handleMessage(normalized.event);
    }
  } catch (e) {
    // Always 200: TikTok retries on non-2xx, and our ledgers already make a retry harmless, but a
    // thrown error here is a bug to surface in `wrangler tail`, not something to hide behind a 500.
    console.error(`[chatmany:tiktok] webhook handling failed (${envelope.event}): ${e instanceof Error ? e.stack ?? e.message : e}`);
  }
  return json({ ok: true });
}

// ---- pure helpers (unit-tested) ----

export type NormalizedTikTokEvent =
  | { kind: "comment"; event: NormalizedComment }
  | { kind: "message"; event: NormalizedMessage }
  | { kind: "ignored"; reason: string };

/**
 * Turn a TikTok envelope into the engine's transport-agnostic events. Only new top-level comments
 * and inbound DMs from personal accounts produce work; everything else is named in `reason` so it
 * is visible in logs.
 */
export function normalizeTikTokEvent(envelope: TikTokEnvelope): NormalizedTikTokEvent {
  const content = parseContent(envelope.content);
  switch (envelope.event) {
    case "comment.update": {
      if (content.comment_action !== "insert") return { kind: "ignored", reason: `comment ${String(content.comment_action)}` };
      if (content.comment_type && content.comment_type !== "comment") return { kind: "ignored", reason: "comment reply" };
      const commentId = idString(content.comment_id);
      const videoId = idString(content.video_id);
      if (!commentId || !videoId) return { kind: "ignored", reason: "comment without ids" };
      return {
        kind: "comment",
        event: {
          kind: "comment",
          comment_id: commentId,
          igsid: typeof content.unique_identifier === "string" ? content.unique_identifier : "",
          text: typeof content.text === "string" ? content.text : "",
          media_id: videoId,
          timestamp: toSeconds(content.timestamp, envelope.create_time),
        },
      };
    }
    case "im_receive_msg": {
      const from = (content.from_user ?? {}) as { id?: string; role?: string };
      if (from.role && from.role !== "personal_account") return { kind: "ignored", reason: `message from ${from.role}` };
      const igsid = from.id || (typeof content.unique_identifier === "string" ? content.unique_identifier : "");
      const conversationId = typeof content.conversation_id === "string" ? content.conversation_id : "";
      if (!igsid || !conversationId) return { kind: "ignored", reason: "message without sender/conversation" };
      const text = content.type === "text" ? (content.text as { body?: string } | undefined)?.body : undefined;
      const payload = (content.reply_source_payload as { reply_source_unique_id?: string } | undefined)?.reply_source_unique_id;
      return {
        kind: "message",
        event: {
          kind: "message",
          igsid,
          text,
          payload,
          timestamp: toSeconds(content.timestamp, envelope.create_time),
          conversation_id: conversationId,
          is_follower: typeof content.is_follower === "boolean" ? content.is_follower : undefined,
          username: typeof content.from === "string" ? content.from : undefined,
          message_id: typeof content.message_id === "string" ? content.message_id : undefined,
        },
      };
    }
    case "im_receive_msg_eu":
      // Stripped payload by design (no sender, no conversation, no body). The polling fallback
      // (/admin/tiktok/poll or TIKTOK_MODE=polling) is the only way to read these.
      return { kind: "ignored", reason: "EU message (stripped payload)" };
    default:
      return { kind: "ignored", reason: envelope.event ?? "unknown event" };
  }
}

/**
 * `content` is a JSON string. comment.update serializes comment_id / video_id / parent_comment_id
 * as bare integers larger than Number.MAX_SAFE_INTEGER, which JSON.parse would silently round —
 * quote them first so they survive as exact strings.
 */
export function parseContent(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  const safe = content.replace(/("(?:comment_id|video_id|parent_comment_id)"\s*:\s*)(\d{15,})/g, '$1"$2"');
  try {
    const parsed = JSON.parse(safe) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function idString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return "";
}

/** Content timestamps are unix milliseconds; the envelope's create_time is seconds. */
function toSeconds(contentTs: unknown, envelopeTs: number | undefined): number {
  if (typeof contentTs === "number" && contentTs > 0) return contentTs > 1e12 ? Math.floor(contentTs / 1000) : Math.floor(contentTs);
  if (typeof envelopeTs === "number" && envelopeTs > 0) return Math.floor(envelopeTs);
  return now();
}

/** `Tiktok-Signature: t=<seconds>,s=<hex>`; HMAC-SHA256(secret, `${t}.${raw}`), constant-time compare, replay window. */
export async function verifyTikTokSignature(
  appSecret: string,
  raw: string,
  header: string | null,
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const s = (parts.s ?? "").toLowerCase();
  if (!Number.isFinite(t) || !s) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = await hmacHex(appSecret, `${t}.${raw}`);
  if (expected.length !== s.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ s.charCodeAt(i);
  return mismatch === 0;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
