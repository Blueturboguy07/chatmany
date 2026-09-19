// Comment poll (Section 5A). Reads comments only for media attached to an active campaign,
// converts them to normalized events, and feeds the engine. A conservative account-wide hourly
// cap on opening DMs guards the shared rate budget across cron ticks (Section 10).

import { getActiveCampaigns, countEventsGlobal, now, processedCommentIds } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedComment } from "../types";

// Private replies cap ~750/hr; DMs ~200/hr. Openings are private replies that open a DM, so we
// pace against the stricter DM limit with margin.
const OPENING_CAP_PER_HOUR = 180;

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
    // ONE batched lookup per page instead of one D1 round trip per comment. The per-comment
    // shape is what Cloudflare killed with outcome=exceededCpu on 2026-08-23: ~300 reads per
    // tick across three media, the invocation cut off mid-loop, and every comment after the cut
    // silently unserved while the app's own tables looked healthy.
    const alreadyProcessed = await processedCommentIds(db, comments.map((c) => c.id));

    for (const c of comments) {
      if (alreadyProcessed.has(c.id)) continue;
      const igsid = c.from?.id;
      if (igsid && igsid === rt.igUserId) continue; // never answer our own comment
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
