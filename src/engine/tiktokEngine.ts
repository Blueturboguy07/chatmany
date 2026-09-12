// TikTok funnel engine. Same ledgers and idempotency rules as the Instagram engine (engine.ts),
// different shape of funnel, because TikTok's official APIs impose one hard constraint the
// Instagram Graph API doesn't: a Business Account cannot open a DM with someone who merely
// commented. Business Messaging only lets us send INTO a conversation the person started
// (docs: "Send a message to a conversation", read 2026-09-09). So:
//
//   comment matches keyword ─public reply under the comment ("DM me SURF")─▶ AWAITING_DM
//   AWAITING_DM ─they DM the keyword (or anything, if it's their only pending funnel)─▶
//        ( is_follower / check_follow ? AWAITING_FOLLOW : ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_FOLLOW ─"I followed" tap/typed, and TikTok reports is_follower─▶ ( ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_EMAIL ─email─▶ DELIVER ─▶ DONE
//
// A keyword DM with no prior comment also enters the funnel (they saw "comment SURF" but DMed
// instead — ManyChat's "user sends a message" trigger). A person already served who DMs the
// keyword again gets the delivery re-sent once per message, so asking twice is never met with
// silence. The `igsid` column holds TikTok's `unique_identifier`, which TikTok documents as the
// same id on comments (Accounts API) and DMs (Business Messaging), so a comment and the DM that
// follows it correlate to one conversation row.
//
// Funnel events keep the Instagram names so the dashboard needs no changes:
//   comment_matched + opening_sent = nudge posted under the comment
//   button_clicked                 = their DM arrived (the "tap")
//   follow_confirmed / email_captured / delivered = as on Instagram

import { TikTokApiError, TT_CODE, QA_TITLE_MAX } from "../api/tiktok";
import type { TikTokClient } from "../api/tiktok";
import type { SendQueue } from "../queue/queue";
import type { Campaign, EventType, NormalizedComment, NormalizedMessage, State } from "../types";
import { commentTriggers, extractEmail } from "./match";
import { afterFollow, afterTap, followRetriesExhausted, titleMatches } from "./transitions";
import {
  claimSend,
  createConversation,
  getActiveCampaigns,
  getCampaign,
  getConversation,
  getOpenConversations,
  isCommentProcessed,
  logEvent,
  logEvents,
  markCommentProcessed,
  releaseSend,
  updateConversation,
} from "../db";
import type { ConversationRow } from "../db";

/** Button id we put on the follow-gate Q&A card; comes back as reply_source_unique_id. */
export const TT_FOLLOW_PAYLOAD = "FOLLOW_CONFIRM";

const DEFAULT_NUDGE = 'DM me "{keyword}" and I\'ll send it over 📩';
const DEFAULT_FOLLOW_GATE = "Follow us first 🙌";
const DEFAULT_FOLLOW_BUTTON = "✅ I followed";
const DEFAULT_EMAIL_ASK = "Reply with your email and I'll send it there too 👇";
/** Card title used when the follow-gate copy is too long for a Q&A card title (40 chars). */
const FOLLOW_CARD_TITLE = "Tap once you've followed";

/** Deterministic rotation through public-reply variants so it looks human. */
function pickRotating(texts: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts[h % texts.length]!;
}

/**
 * The public reply posted under a matching comment. If the campaign's "reply to their comment"
 * texts are enabled they rotate; otherwise `copy.opening` is used (on TikTok the opening IS the
 * public nudge, since there is no private reply to a comment). `{keyword}` becomes the first
 * keyword so the copy can say exactly what to DM.
 */
export function renderNudge(campaign: Campaign, seed: string): string {
  const texts = campaign.public_reply?.enabled ? campaign.public_reply.texts : [];
  const base = texts.length > 0 ? pickRotating(texts, seed) : campaign.copy.opening?.trim() || DEFAULT_NUDGE;
  return base.replaceAll("{keyword}", campaign.keywords[0] ?? "");
}

/** The delivery message, with {reward} substituted. */
export function renderDelivery(campaign: Campaign): string {
  return campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value);
}

interface Target {
  igsid: string;
  conversation_id: string;
}

export class TikTokEngine {
  constructor(
    private readonly db: D1Database,
    private readonly client: TikTokClient,
    private readonly queue: SendQueue,
  ) {}

  // ---- comments ----

  /** A new top-level comment on an owned video: keyword match → public nudge → AWAITING_DM. */
  async handleComment(evt: NormalizedComment, activeCampaigns?: Campaign[]): Promise<void> {
    if (await isCommentProcessed(this.db, evt.comment_id)) return;
    if (!evt.igsid) return; // without the commenter's id their later DM can't be correlated

    const all = activeCampaigns ?? (await getActiveCampaigns(this.db, "tiktok"));
    const campaigns = all.filter((c) => c.media_id === evt.media_id);
    let matchedCampaignId = "-";
    let pendingRetry = false;

    for (const campaign of campaigns) {
      if (!commentTriggers(evt.text, campaign.keywords, campaign.exclude)) continue;
      matchedCampaignId = campaign.campaign_id;

      // Someone already past the nudge (in the DM flow, or served) is not nagged publicly again.
      const existing = await getConversation(this.db, evt.igsid, campaign.campaign_id);
      if (existing && existing.state !== "AWAITING_DM") continue;

      const sent = await this.trySend(
        () => this.client.replyToComment(evt.media_id, evt.comment_id, renderNudge(campaign, evt.comment_id)),
        "nudge",
        `nudge:${campaign.campaign_id}:${evt.comment_id}`,
      );
      if (!sent) {
        pendingRetry = true;
        continue;
      }
      if (!existing) {
        await createConversation(this.db, evt.igsid, campaign.campaign_id, evt.username ?? null, "AWAITING_DM");
        await logEvents(this.db, [
          { campaignId: campaign.campaign_id, type: "comment_matched", igsid: evt.igsid },
          { campaignId: campaign.campaign_id, type: "opening_sent", igsid: evt.igsid },
        ]);
      }
    }

    if (!pendingRetry) await markCommentProcessed(this.db, evt.comment_id, evt.igsid, matchedCampaignId);
  }

  // ---- messages ----

  /** An inbound DM from a personal account. Advances every open funnel it applies to. */
  async handleMessage(evt: NormalizedMessage): Promise<void> {
    if (!evt.conversation_id) return; // nothing can be sent without a conversation to send into

    const open = await getOpenConversations(this.db, evt.igsid);
    const awaitingDm = open.filter((c) => c.state === "AWAITING_DM");
    const handled = new Set<string>();

    for (const convo of open) {
      const campaign = await getCampaign(this.db, convo.campaign_id);
      if (!campaign || campaign.platform !== "tiktok") continue;
      handled.add(campaign.campaign_id);

      if (convo.state === "AWAITING_DM") {
        // No timestamp guard here: the comment webhook can land up to 5 minutes after the comment,
        // so the DM may legitimately predate this row's updated_at. Idempotency comes from the send
        // claims and from the state leaving AWAITING_DM once handled.
        const keyed = commentTriggers(evt.text ?? "", campaign.keywords, campaign.exclude);
        if (!keyed && awaitingDm.length !== 1) continue; // ambiguous: which funnel did they mean?
        await this.onDm(campaign, evt);
        continue;
      }

      // Only act on a message newer than our last transition (re-reads must not advance twice).
      if (evt.timestamp <= convo.updated_at) continue;
      switch (convo.state as State) {
        case "AWAITING_FOLLOW":
          await this.onFollow(campaign, evt, convo.follow_retries);
          break;
        case "AWAITING_EMAIL":
          await this.onEmail(campaign, evt);
          break;
        default:
          break;
      }
    }

    // Keyword DM with no prior comment, or an already-served person asking again.
    if (!evt.text) return;
    for (const campaign of await getActiveCampaigns(this.db, "tiktok")) {
      if (handled.has(campaign.campaign_id)) continue;
      if (!commentTriggers(evt.text, campaign.keywords, campaign.exclude)) continue;
      const existing = await getConversation(this.db, evt.igsid, campaign.campaign_id);
      if (!existing) {
        await createConversation(this.db, evt.igsid, campaign.campaign_id, evt.username ?? null, "AWAITING_DM", evt.conversation_id);
        await this.onDm(campaign, evt);
      } else if (existing.state === "DONE") {
        await this.redeliver(campaign, evt);
      }
    }
  }

  /**
   * Every inbound message that completes a transition is remembered per campaign, so a webhook
   * retry (or a polling re-read) of the same message can never act twice — in particular it must
   * not look like "an already-served person asking again" and trigger a second delivery.
   */
  private seenKey(campaign: Campaign, evt: NormalizedMessage): string {
    return `msg:${campaign.campaign_id}:${evt.igsid}:${evt.message_id ?? evt.timestamp}`;
  }

  /** Their DM arrived: record the conversation to answer on, then run the gates or deliver. */
  private async onDm(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    const target: Target = { igsid: evt.igsid, conversation_id: evt.conversation_id! };
    await updateConversation(this.db, evt.igsid, campaign.campaign_id, { conversation_id: target.conversation_id });

    let next = afterTap(campaign);
    let extraEvent: EventType | undefined;
    let patch: Partial<Pick<ConversationRow, "followed">> | undefined;
    // TikTok says whether they already follow — no need to gate someone who does.
    if (next === "AWAITING_FOLLOW" && evt.is_follower === true) {
      next = afterFollow(campaign);
      extraEvent = "follow_confirmed";
      patch = { followed: 1 };
    }
    const committed = await this.enterState(campaign, target, next, { entryEvent: "button_clicked", extraEvent, patch });
    if (committed) await claimSend(this.db, this.seenKey(campaign, evt));
  }

  private async onFollow(campaign: Campaign, evt: NormalizedMessage, retries: number): Promise<void> {
    const expected = campaign.copy.follow_button ?? DEFAULT_FOLLOW_BUTTON;
    const isConfirm = evt.payload === TT_FOLLOW_PAYLOAD || titleMatches(evt.text, expected);
    if (!isConfirm) return;

    const target: Target = { igsid: evt.igsid, conversation_id: evt.conversation_id! };
    // The webhook reports is_follower; when TikTok says they don't follow, re-send the gate (capped).
    if (evt.is_follower === false && !followRetriesExhausted(retries)) {
      await this.resendFollowGate(campaign, target, retries);
      return;
    }
    await this.enterState(campaign, target, afterFollow(campaign), { entryEvent: "follow_confirmed", patch: { followed: 1 } });
  }

  private async onEmail(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    const target: Target = { igsid: evt.igsid, conversation_id: evt.conversation_id! };
    const email = evt.email ?? extractEmail(evt.text);
    if (!email) {
      const ok = await this.trySend(
        () => this.client.sendText(target.conversation_id, campaign.copy.email_ask ?? DEFAULT_EMAIL_ASK),
        "email_ask_resend",
      );
      if (ok) await updateConversation(this.db, evt.igsid, campaign.campaign_id, { state: "AWAITING_EMAIL" });
      return;
    }
    await this.enterState(campaign, target, "DELIVER", { entryEvent: "email_captured", patch: { email } });
  }

  /** Someone already served DMs the keyword again: send the delivery once more, once per message. */
  private async redeliver(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    const seen = this.seenKey(campaign, evt);
    if (!(await claimSend(this.db, seen))) return; // retry of a message that was already acted on
    const outcome = await this.attempt(() => this.client.sendText(evt.conversation_id!, renderDelivery(campaign)), "redelivery", null);
    if (outcome === "refused") {
      await releaseSend(this.db, seen); // nothing went out; let the retry try again
      return;
    }
    await updateConversation(this.db, evt.igsid, campaign.campaign_id, { state: "DONE", conversation_id: evt.conversation_id! });
    await logEvent(this.db, campaign.campaign_id, "delivered", evt.igsid);
  }

  /**
   * Enter a target state: send first, then — only if the send succeeded — persist the state,
   * the patch and the entry event(s) together. A failed send changes nothing, so the triggering
   * message is handled again on the next delivery/poll. DELIVER collapses to DONE.
   */
  private async enterState(
    campaign: Campaign,
    target: Target,
    next: State,
    opts: { entryEvent?: EventType; extraEvent?: EventType; patch?: Partial<Pick<ConversationRow, "email" | "followed">> } = {},
  ): Promise<boolean> {
    const commit = async (restingState: State, ...events: (EventType | undefined)[]) => {
      await updateConversation(this.db, target.igsid, campaign.campaign_id, { state: restingState, ...opts.patch });
      for (const e of [opts.entryEvent, opts.extraEvent, ...events]) {
        if (e) await logEvent(this.db, campaign.campaign_id, e, target.igsid);
      }
    };

    switch (next) {
      case "AWAITING_FOLLOW": {
        const ok = await this.trySend(
          () => this.sendFollowGate(campaign, target),
          "follow_gate",
          `follow_gate:${campaign.campaign_id}:${target.igsid}`,
        );
        if (!ok) return false;
        await commit("AWAITING_FOLLOW");
        break;
      }
      case "AWAITING_EMAIL": {
        const ok = await this.trySend(
          () => this.client.sendText(target.conversation_id, campaign.copy.email_ask ?? DEFAULT_EMAIL_ASK),
          "email_ask",
          `email_ask:${campaign.campaign_id}:${target.igsid}`,
        );
        if (!ok) return false;
        await commit("AWAITING_EMAIL");
        break;
      }
      case "DELIVER": {
        const ok = await this.trySend(
          () => this.client.sendText(target.conversation_id, renderDelivery(campaign)),
          "delivery",
          `delivery:${campaign.campaign_id}:${target.igsid}`,
        );
        if (!ok) return false;
        await commit("DONE", "delivered");
        break;
      }
      default:
        await commit(next);
    }
    return true;
  }

  /**
   * The follow gate as a Q&A button card. Card titles are capped at 40 characters, so longer
   * gate copy goes out as a text message first, followed by a short card carrying the button.
   */
  private async sendFollowGate(campaign: Campaign, target: Target): Promise<unknown> {
    const gate = campaign.copy.follow_gate ?? DEFAULT_FOLLOW_GATE;
    const button = { title: campaign.copy.follow_button ?? DEFAULT_FOLLOW_BUTTON, id: TT_FOLLOW_PAYLOAD };
    if ([...gate].length <= QA_TITLE_MAX) {
      return this.client.sendQaButtons(target.conversation_id, gate, [button]);
    }
    await this.client.sendText(target.conversation_id, gate);
    return this.client.sendQaButtons(target.conversation_id, FOLLOW_CARD_TITLE, [button]);
  }

  private async resendFollowGate(campaign: Campaign, target: Target, retries: number): Promise<void> {
    const ok = await this.trySend(() => this.sendFollowGate(campaign, target), "follow_gate_resend");
    if (ok) await updateConversation(this.db, target.igsid, campaign.campaign_id, { follow_retries: retries + 1 });
  }

  // ---- send helper (same at-most-once contract as engine.ts) ----

  /**
   * Run a send through the queue, at most once per `key`. A definite refusal (TikTok answered
   * with a non-5xx error code, including rate limiting) releases the claim so the caller retries;
   * an ambiguous outcome (network error, 5xx, TikTok "system error") keeps the claim and reports
   * success, because the message may already be in the person's inbox.
   */
  private async trySend<T>(fn: () => Promise<T>, label: string, key?: string): Promise<boolean> {
    return (await this.attempt(fn, label, key ?? null)) !== "refused";
  }

  private async attempt<T>(fn: () => Promise<T>, label: string, claimKey: string | null): Promise<"sent" | "skipped" | "refused"> {
    if (claimKey && !(await claimSend(this.db, claimKey))) {
      console.warn(`[chatmany:tiktok] skipping ${label}: already attempted, may have delivered (${claimKey})`);
      return "skipped";
    }
    try {
      await this.queue.run(fn);
      return "sent";
    } catch (e) {
      const refused = e instanceof TikTokApiError && !isAmbiguousFailure(e);
      if (refused) {
        if (claimKey) await releaseSend(this.db, claimKey);
        console.warn(`[chatmany:tiktok] send failed (${label}), will retry: ${msg(e)}`);
        return "refused";
      }
      console.warn(`[chatmany:tiktok] send outcome unknown (${label}): ${msg(e)} — treating as delivered so it is not sent twice`);
      return claimKey ? "sent" : "refused";
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when a failed send tells us nothing about whether the message went out. */
function isAmbiguousFailure(e: TikTokApiError): boolean {
  if (e.isRateLimit) return false;
  return e.status >= 500 || e.code === TT_CODE.SYSTEM_ERROR;
}
