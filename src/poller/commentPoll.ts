// Comment poll (Section 5A). Reads comments only for media attached to an active campaign,
// converts them to normalized events, and feeds the engine. A conservative account-wide hourly
// cap on opening DMs guards the shared rate budget across cron ticks (Section 10).

import { getActiveCampaigns, countEventsGlobal, now, processedCommentIds } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedComment } from "../types";

// Meta's documented ceiling for private replies to comments is ~750/hr, and every opening we send
// IS a private reply (both the button-template opening and a deliver_in_opening send), so that is
// the limit that binds. Set to the ceiling deliberately (founder call, 2026-08-23) rather than to
// a fraction of it: a viral reel can out-run a conservative cap, and comments that sit unprocessed
// long enough scroll out of the getComments window and are missed for good. Genuine 429s are not
// lost — SendQueue backs off and retries them.
const OPENING_CAP_PER_HOUR = 750;

export async function pollComments(rt: Runtime, db: D1Database): Promise<void> {
  const campaigns = await getActiveCampaigns(db);
  if (campaigns.length === 0) return;

  const sinceHour = now() - 3600;
  const openingsThisHour = await countEventsGlobal(db, "opening_sent", sinceHour);
  if (openingsThisHour >= OPENING_CAP_PER_HOUR) {
    console.warn(`[chatmany] opening cap reached (${openingsThisHour}/hr); deferring comment poll.`);
    return;
  }

  // Dedupe media so shared media across campaigns is fetched once.
  const mediaIds = [...new Set(campaigns.map((c) => c.media_id))];
  for (const mediaId of mediaIds) {
    let comments;
    try {
      comments = await rt.client.getComments(mediaId);
    } catch (e) {
      console.warn(`[chatmany] getComments(${mediaId}) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // Batch the "have we already handled this?" lookup for the whole page. Without this the
    // engine issues one D1 read per comment, which at a 100-comment window across several media
    // is enough to blow the scheduled invocation's CPU budget and get the tick killed mid-way.
    let alreadyHandled: Set<string>;
    try {
      alreadyHandled = await processedCommentIds(db, comments.map((c) => c.id));
    } catch (e) {
      console.warn(`[chatmany] processedCommentIds failed: ${e instanceof Error ? e.message : e}`);
      alreadyHandled = new Set();
    }

    for (const c of comments) {
      if (alreadyHandled.has(c.id)) continue;
      const igsid = c.from?.id;
      if (!igsid) {
        // Meta's Graph API omits `from.id` for some commenters (permissions/visibility vary by
        // account); without it we can't correlate a later DM reply, so the comment is unreachable.
        // Logged (rather than silently dropped) since this can otherwise look identical to a
        // keyword-matching failure from the outside.
        console.warn(
          `[chatmany] comment ${c.id} on ${mediaId} has no commenter id (from=${JSON.stringify(c.from)}); skipping: "${c.text ?? ""}"`,
        );
        continue;
      }
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: c.id,
        igsid,
        username: c.from?.username ?? c.username,
        text: c.text ?? "",
        media_id: mediaId,
        timestamp: toUnixSeconds(c.timestamp),
      };
      // Pass the campaigns we already fetched so the engine doesn't re-query per comment.
      await rt.engine.handleComment(evt, campaigns);
    }
  }
}
