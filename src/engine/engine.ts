// Transport-agnostic funnel engine (Section 5, 6). Consumes normalized comment/message events
// from EITHER the poller or the webhook route and advances each person's state machine. All
// side-effects (DMs, public actions) run idempotently via the ledgers, so re-polls and webhook
// retries never double-message anyone.

import type { InstagramClient } from "../api/client";
import type { SendQueue } from "../queue/queue";
import type {
  Campaign,
  EventType,
  NormalizedComment,
  NormalizedMessage,
  State,
} from "../types";
import { InstagramApiError } from "../api/client";
import { commentTriggers, extractEmail } from "./match";
import { afterFollow, afterTap, expectedTitleForState, followRetriesExhausted, titleMatches } from "./transitions";
import {
  claimCommentAction,
  claimSend,
  createConversation,
  getActiveCampaigns,
  getCampaign,
  getConversation,
  getOpenConversations,
  isCommentProcessed,
  kvGet,
  kvSet,
  logEvent,
  logEvents,
  markCommentProcessed,
  releaseSend,
  updateConversation,
} from "../db";
import type { ConversationRow } from "../db";

const OPENING_PAYLOAD = "OPENING_TAP";
const FOLLOW_PAYLOAD = "FOLLOW_CONFIRM";

/** Deterministic rotation through public-reply variants so it looks human. */
function pickRotating(texts: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts[h % texts.length]!;
}

export class Engine {
  constructor(
    private readonly db: D1Database,
    private readonly client: InstagramClient,
    private readonly queue: SendQueue,
  ) {}

  // ---- comments ----

  /**
   * Handle a new comment: trigger match → public actions → opening DM. Idempotent per comment.
   * `activeCampaigns` may be passed by the poller (already fetched) to avoid a DB read per comment;
   * the webhook path omits it and we fetch on demand.
   */
  async handleComment(evt: NormalizedComment, activeCampaigns?: Campaign[]): Promise<void> {
    if (await isCommentProcessed(this.db, evt.comment_id)) return;
    if (!evt.igsid) return; // cannot correlate future messages without the commenter's IGSID

    const all = activeCampaigns ?? (await getActiveCampaigns(this.db));
    const campaigns = all.filter((c) => c.media_id === evt.media_id);
    let matchedCampaignId = "-";
    // A retryable opening-send failure leaves the comment unprocessed so the next poll retries it.
    let pendingRetry = false;

    for (const campaign of campaigns) {
      if (!commentTriggers(evt.text, campaign.keywords, campaign.exclude)) continue;
      matchedCampaignId = campaign.campaign_id;

      // Public actions are per-comment (independent toggles), guarded so re-polls don't repeat them.
      await this.runPublicActions(campaign, evt);

      // Dedup DM: multiple comments from one person = exactly one opening DM per campaign.
      const existing = await getConversation(this.db, evt.igsid, campaign.campaign_id);
      if (existing) continue;

      // New lead: comment_matched + opening_sent are logged only when the opening actually sends,
      // so a failed send neither inflates the funnel nor is double-counted on the retry.
      const sent = await this.sendOpening(campaign, evt);
      if (!sent) pendingRetry = true;
    }

    // Mark processed once nothing is awaiting retry, so we don't re-scan this comment every poll.
    if (!pendingRetry) await markCommentProcessed(this.db, evt.comment_id, evt.igsid, matchedCampaignId);
  }

  private async runPublicActions(campaign: Campaign, evt: NormalizedComment): Promise<void> {
    if (campaign.public_reply?.enabled && campaign.public_reply.texts.length > 0) {
      if (await claimCommentAction(this.db, evt.comment_id, "public_reply")) {
        const text = pickRotating(campaign.public_reply.texts, evt.comment_id);
        await this.trySend(() => this.client.replyToComment(evt.comment_id, text), "public_reply");
      }
    }
    // `like_comment` is intentionally not acted on: Instagram's API has no way to like a comment
    // (see the note in api/client.ts). The field is still accepted so older saved campaigns keep
    // loading, but it does nothing.
  }

  /**
   * Open the chat via a private reply to the comment, using a postback button (Step 1).
   * Returns true if the opening was sent and the funnel entry recorded; false on a send failure
   * (so the caller leaves the comment unprocessed for a retry on the next poll).
   */
  private async sendOpening(campaign: Campaign, evt: NormalizedComment): Promise<boolean> {
    // Direct mode: the private reply IS the delivery — one plain-text message with the reward,
    // nothing to tap. The funnel is complete the moment it sends, so the conversation opens DONE.
    if (campaign.deliver_in_opening) {
      const text = renderDelivery(campaign);
      const ok = await this.trySend(
        () => this.client.privateReplyText(evt.comment_id, text),
        "opening_direct",
        `opening:${campaign.campaign_id}:${evt.comment_id}`,
      );
      if (!ok) return false;
      await createConversation(this.db, evt.igsid, campaign.campaign_id, evt.username ?? null, "DONE");
      await logEvents(this.db, [
        { campaignId: campaign.campaign_id, type: "comment_matched", igsid: evt.igsid },
        { campaignId: campaign.campaign_id, type: "opening_sent", igsid: evt.igsid },
        { campaignId: campaign.campaign_id, type: "delivered", igsid: evt.igsid },
      ]);
      return true;
    }

    const button = {
      type: "postback" as const,
      title: campaign.copy.opening_button ?? "Continue",
      payload: OPENING_PAYLOAD,
    };
    const ok = await this.trySend(
      () => this.client.privateReplyWithButtons(evt.comment_id, campaign.copy.opening, [button]),
      "opening",
      `opening:${campaign.campaign_id}:${evt.comment_id}`,
    );
    if (!ok) return false;
    await createConversation(this.db, evt.igsid, campaign.campaign_id, evt.username ?? null, "AWAITING_TAP");
    await logEvents(this.db, [
      { campaignId: campaign.campaign_id, type: "comment_matched", igsid: evt.igsid },
      { campaignId: campaign.campaign_id, type: "opening_sent", igsid: evt.igsid },
    ]);
    return true;
  }

  // ---- messages ----

  /**
   * Handle an inbound message: advance any of this person's open conversations. In polling mode
   * the hidden payload is often unavailable, so taps are resolved by matching the message text to
   * the expected button title for the current state (and, for AWAITING_TAP, any inbound message
   * counts — the opening postback posts no visible text; webhook mode also delivers the payload).
   */
  async handleMessage(evt: NormalizedMessage): Promise<void> {
    const open = await getOpenConversations(this.db, evt.igsid);
    for (const convo of open) {
      // Idempotency: only act on a message that arrived after our last transition, so re-reads of
      // the same message in the conversation history don't advance the funnel twice.
      if (evt.timestamp <= convo.updated_at) continue;

      const campaign = await getCampaign(this.db, convo.campaign_id);
      if (!campaign) continue;

      switch (convo.state as State) {
        case "AWAITING_TAP":
          await this.onTap(campaign, evt);
          break;
        case "AWAITING_FOLLOW":
          await this.onFollow(campaign, evt, convo.follow_retries);
          break;
        case "AWAITING_EMAIL":
          await this.onEmail(campaign, evt);
          break;
        default:
          break; // NEW / DELIVER / DONE — nothing to do
      }
    }
  }

  private async onTap(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    // Any inbound message (or an explicit OPENING_TAP payload) counts as the tap. The
    // button_clicked event is logged inside enterState, only once the next message actually sends,
    // so a failed send leaves the tap message unconsumed (updated_at unchanged) for a clean retry.
    await this.enterState(campaign, evt.igsid, afterTap(campaign), { entryEvent: "button_clicked" });
  }

  private async onFollow(campaign: Campaign, evt: NormalizedMessage, retries: number): Promise<void> {
    const expected = expectedTitleForState("AWAITING_FOLLOW", campaign) ?? "";
    const isConfirm = evt.payload === FOLLOW_PAYLOAD || titleMatches(evt.text, expected);
    if (!isConfirm) return; // unrelated message; stay in AWAITING_FOLLOW

    // verify_follow_count: weak heuristic (documented unreliable). Compare follower total against
    // the baseline captured when the gate was sent; if it didn't grow, re-send and stay (capped).
    if (campaign.verify_follow_count && !followRetriesExhausted(retries)) {
      const looksFollowed = await this.followerCountGrew(campaign, evt.igsid);
      if (!looksFollowed) {
        await this.resendFollowGate(campaign, evt.igsid, retries);
        return;
      }
    }

    await this.enterState(campaign, evt.igsid, afterFollow(campaign), {
      entryEvent: "follow_confirmed",
      patch: { followed: 1 },
    });
  }

  private async onEmail(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    const email = evt.email ?? extractEmail(evt.text);
    if (!email) {
      // Not a valid email (no @ / not chip-provided) — re-ask instead of silently ignoring it,
      // so the person gets a nudge rather than the bot going quiet. Resource is never sent from here.
      await this.resendEmailAsk(campaign, evt.igsid);
      return;
    }
    await this.enterState(campaign, evt.igsid, "DELIVER", { entryEvent: "email_captured", patch: { email } });
  }

  private async resendEmailAsk(campaign: Campaign, igsid: string): Promise<void> {
    const ok = await this.trySend(
      () =>
        this.client.sendQuickReplies(
          igsid,
          campaign.copy.email_ask ?? "Tap your email or reply with it 👇",
          [{ content_type: "user_email" }],
        ),
      "email_ask_resend",
    );
    // Only mark the invalid-reply message as handled once the re-ask actually sent — same
    // fail-clean pattern as every other send: a failed resend leaves updated_at untouched so the
    // same message retries cleanly on the next poll instead of being silently dropped.
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, { state: "AWAITING_EMAIL" });
    }
  }

  /**
   * Enter a target state: perform the outbound send first, then — only if it succeeded — persist
   * the new state together with any field patch and log the entry event, in that single write. A
   * failed send changes nothing (no state, no updated_at bump, no event), so the triggering message
   * re-fires on the next poll and the entry event is never double-counted. DELIVER collapses to DONE.
   */
  private async enterState(
    campaign: Campaign,
    igsid: string,
    target: State,
    opts: { entryEvent?: EventType; patch?: Partial<Pick<ConversationRow, "email" | "followed">> } = {},
  ): Promise<void> {
    const commit = async (restingState: State, extra?: EventType) => {
      await updateConversation(this.db, igsid, campaign.campaign_id, { state: restingState, ...opts.patch });
      if (opts.entryEvent) await logEvent(this.db, campaign.campaign_id, opts.entryEvent, igsid);
      if (extra) await logEvent(this.db, campaign.campaign_id, extra, igsid);
    };

    switch (target) {
      case "AWAITING_FOLLOW": {
        const ok = await this.trySend(
          () =>
            this.client.sendQuickReplies(igsid, campaign.copy.follow_gate ?? "Follow us first 🙌", [
              { content_type: "text", title: campaign.copy.follow_button ?? "✅ I followed", payload: FOLLOW_PAYLOAD },
            ]),
          "follow_gate",
          `follow_gate:${campaign.campaign_id}:${igsid}`,
        );
        if (!ok) return;
        if (campaign.verify_follow_count) await this.captureFollowerBaseline(campaign, igsid);
        await commit("AWAITING_FOLLOW");
        break;
      }
      case "AWAITING_EMAIL": {
        const ok = await this.trySend(
          () =>
            this.client.sendQuickReplies(
              igsid,
              campaign.copy.email_ask ?? "Tap your email or reply with it 👇",
              [{ content_type: "user_email" }],
            ),
          "email_ask",
          `email_ask:${campaign.campaign_id}:${igsid}`,
        );
        if (!ok) return;
        await commit("AWAITING_EMAIL");
        break;
      }
      case "DELIVER": {
        const text = renderDelivery(campaign);
        const ok = await this.trySend(
          () => this.client.sendText(igsid, text),
          "delivery",
          `delivery:${campaign.campaign_id}:${igsid}`,
        );
        if (!ok) return;
        await commit("DONE", "delivered");
        break;
      }
      default:
        await commit(target);
    }
  }

  private async resendFollowGate(campaign: Campaign, igsid: string, retries: number): Promise<void> {
    const ok = await this.trySend(
      () =>
        this.client.sendQuickReplies(igsid, campaign.copy.follow_gate ?? "Follow us first 🙌", [
          { content_type: "text", title: campaign.copy.follow_button ?? "✅ I followed", payload: FOLLOW_PAYLOAD },
        ]),
      "follow_gate_resend",
    );
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, { follow_retries: retries + 1 });
    }
  }

  // ---- verify_follow_count helpers (weak heuristic) ----

  private baselineKey(campaign: Campaign, igsid: string): string {
    return `follow_baseline:${campaign.campaign_id}:${igsid}`;
  }

  private async captureFollowerBaseline(campaign: Campaign, igsid: string): Promise<void> {
    try {
      const count = await this.client.getFollowersCount();
      if (count !== undefined) await kvSet(this.db, this.baselineKey(campaign, igsid), String(count));
    } catch {
      // best-effort; absence just means we fail open on confirm
    }
  }

  private async followerCountGrew(campaign: Campaign, igsid: string): Promise<boolean> {
    const baselineRaw = await kvGet(this.db, this.baselineKey(campaign, igsid));
    if (baselineRaw === null) return true; // no baseline → fail open (advance)
    try {
      const current = await this.client.getFollowersCount();
      if (current === undefined) return true;
      return current > Number(baselineRaw);
    } catch {
      return true;
    }
  }

  // ---- send helpers ----

  /**
   * Run a send through the queue, at most once per `key`.
   *
   * Sends are claimed before they go out. The outcome of a failed send is not always knowable:
   * a timeout, dropped connection, or 5xx can all arrive *after* Instagram already delivered the
   * message. Treating those as "never happened" and retrying is what shows a person the same DM
   * twice, so instead:
   *
   *   - the platform answered with an error (any HTTP status) → the request reached Instagram and
   *     was rejected, so nothing was delivered: release the claim and report failure so the caller
   *     retries cleanly on the next poll;
   *   - no answer at all (network error, timeout, dropped connection) → we never learned the
   *     outcome and it may well have landed, so keep the claim and report success, advancing the
   *     funnel rather than risking a duplicate;
   *   - claim already held → a previous attempt got far enough to send, so skip and report
   *     success. This is what catches a retry after the Worker died mid-send.
   *
   * The trade is deliberate: at-most-once delivery. A genuinely lost message leaves that person
   * where they were instead of being messaged again.
   */
  private async trySend<T>(fn: () => Promise<T>, label: string, key?: string): Promise<boolean> {
    const claimKey = key ?? null;
    if (claimKey && !(await claimSend(this.db, claimKey))) {
      console.warn(`[chatmany] skipping ${label}: already attempted, may have delivered (${claimKey})`);
      return true;
    }
    try {
      await this.queue.run(fn);
      return true;
    } catch (e) {
      // A 4xx InstagramApiError means Instagram refused the request outright, so nothing went out
      // and retrying is safe. Everything else is an AMBIGUOUS outcome — the message may already be
      // in the person's inbox — and must never be retried blind: a fetch that threw (timeout,
      // socket closed), and equally a 5xx, which Instagram returns for sends it has actually
      // delivered (see isAmbiguousFailure). Retrying those re-DMs someone every poll, forever.
      const refused = e instanceof InstagramApiError && !isAmbiguousFailure(e);
      if (refused) {
        if (claimKey) await releaseSend(this.db, claimKey);
        console.warn(`[chatmany] send failed (${label}), will retry: ${msg(e)}`);
        return false;
      }
      console.warn(
        `[chatmany] send outcome unknown (${label}): ${msg(e)} — treating as delivered so it is not sent twice`,
      );
      return claimKey ? true : false;
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * True when a failed send tells us nothing about whether the message went out.
 *
 * Instagram answers `HTTP 500 / code 1 "An unknown error has occurred."` for private replies it
 * has, in fact, delivered — observed live on 2026-08-23, where every "failed" opening landed in
 * the recipient's inbox and the retry loop re-sent it every 90s. A 5xx is never proof of refusal.
 * Genuine rate limiting (429 / codes 4, 17, 32, 613, 80007) IS a refusal: nothing was sent, and
 * the queue's backoff is the right answer, so it stays retryable.
 */
function isAmbiguousFailure(e: InstagramApiError): boolean {
  if (e.isRateLimit) return false;
  return e.status >= 500 || e.code === 1 || e.code === 2;
}

/** The delivery message a campaign sends, with {reward} substituted. */
function renderDelivery(campaign: Campaign): string {
  return campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value);
}
