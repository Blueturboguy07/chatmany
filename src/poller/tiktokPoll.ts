// TikTok polling fallback (TIKTOK_MODE=polling, or POST /admin/tiktok/poll). Webhooks are the
// primary transport for TikTok — comment.update and im_receive_msg are pushed within minutes —
// but polling lets the funnel run before the webhook subscription exists, serves EU senders whose
// webhook payload is stripped, and gives a manual "run it now" for testing.
//
// Budget: Accounts API allows 40 queries/minute per endpoint per account; conversation reads are
// one list call per type plus one content call per conversation that changed since the cursor.

import { getActiveCampaigns, kvGet, kvSet, now, processedCommentIds } from "../db";
import type { TikTokRuntime } from "../tiktokRuntime";
import type { NormalizedComment, NormalizedMessage } from "../types";

const MSG_CURSOR_KEY = "tiktok_last_msg_poll_ts"; // unix ms
const OVERLAP_MS = 120_000;
const MAX_CONVERSATIONS_PER_TICK = 25;

export async function pollTikTokComments(rt: TikTokRuntime, db: D1Database): Promise<void> {
  const campaigns = await getActiveCampaigns(db, "tiktok");
  if (campaigns.length === 0) return;
  const videoIds = [...new Set(campaigns.map((c) => c.media_id))];

  for (const videoId of videoIds) {
    let comments;
    try {
      comments = (await rt.client.listComments(videoId, 30)).comments;
    } catch (e) {
      console.warn(`[chatmany:tiktok] listComments(${videoId}) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const handled = await processedCommentIds(db, comments.map((c) => c.comment_id));
    for (const c of comments) {
      if (handled.has(c.comment_id)) continue;
      if (c.owner || c.parent_comment_id) continue; // our own replies / nested replies never trigger
      const igsid = c.unique_identifier || c.user_id;
      if (!igsid) continue;
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: c.comment_id,
        igsid,
        username: c.username,
        text: c.text ?? "",
        media_id: videoId,
        timestamp: Number(c.create_time) || now(),
      };
      await rt.engine.handleComment(evt, campaigns);
    }
  }
}

export async function pollTikTokMessages(rt: TikTokRuntime, db: D1Database): Promise<void> {
  const cursorRaw = await kvGet(db, MSG_CURSOR_KEY);
  const cursor = cursorRaw ? Number(cursorRaw) : 0;
  const floor = cursor > 0 ? cursor - OVERLAP_MS : 0;

  let conversations: { conversation_id: string; update_time?: number }[] = [];
  for (const type of ["STRANGER", "SINGLE"] as const) {
    try {
      conversations.push(...(await rt.client.listConversations(type)));
    } catch (e) {
      console.warn(`[chatmany:tiktok] listConversations(${type}) failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  conversations = conversations
    .filter((c) => (c.update_time ?? 0) >= floor)
    .sort((a, b) => (b.update_time ?? 0) - (a.update_time ?? 0))
    .slice(0, MAX_CONVERSATIONS_PER_TICK);

  let maxTs = cursor;
  for (const convo of conversations) {
    let messages, participants;
    try {
      ({ messages, participants } = await rt.client.listMessages(convo.conversation_id));
    } catch (e) {
      console.warn(`[chatmany:tiktok] listMessages failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const person = participants.find((p) => p.role === "PERSONAL_ACCOUNT");
    for (const m of messages) {
      const fromId = m.from_user?.id;
      if (!fromId || fromId === rt.businessId || m.from_user?.role === "BUSINESS_ACCOUNT") continue;
      const ts = m.timestamp ?? 0;
      if (ts < floor) continue;
      if (ts > maxTs) maxTs = ts;
      const evt: NormalizedMessage = {
        kind: "message",
        igsid: fromId,
        text: m.message_type === "TEXT" ? m.text?.body : undefined,
        timestamp: Math.floor(ts / 1000),
        conversation_id: convo.conversation_id,
        is_follower: person?.is_follower,
        username: person?.display_name,
        message_id: m.message_id,
      };
      await rt.engine.handleMessage(evt);
    }
  }
  await kvSet(db, MSG_CURSOR_KEY, String(Math.max(maxTs, Date.now() - OVERLAP_MS)));
}
