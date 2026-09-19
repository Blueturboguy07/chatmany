// Transport-agnostic funnel engine (Section 5, 6). Consumes normalized comment/message events
// from the poller, the backlog sweep or the webhook route and advances each person's state
// machine. All side-effects (DMs, public actions) run idempotently via the ledgers, so re-polls
// and webhook retries never double-message anyone.
//
// The engine is tenant-agnostic: it holds an EngineStore, which is a TenantDb bound to one
// tenant (hosted) or to 'self' (self-host). It never sees a raw D1Database.

import type { InstagramClient } from "../api/client";
import type { SendQueue } from "../queue/queue";
import type {
  Campaign,
  EventType,
  NormalizedComment,
  NormalizedMessage,
  State,
} from "../types";
import { classifySendFailure, failureTag } from "./failure";
import type { SendFailure } from "./failure";
import { commentTriggers, extractEmail } from "./match";
import { afterFollow, afterTap, expectedTitleForState, followRetriesExhausted, titleMatches } from "./transitions";
import { SELF_TENANT, TenantDb } from "../tenant/db";
import type { EngineStore } from "./store";
import type { ConversationRow } from "../tenant/db";

const OPENING_PAYLOAD = "OPENING_TAP";
const FOLLOW_PAYLOAD = "FOLLOW_CONFIRM";

/**
 * Instagram accepts a private reply only within 7 days of the comment. Past that the send can
 * only fail, so the comment is marked processed instead of being retried every tick forever
 * (fix2, 2026-09-15).
 */
const PRIVATE_REPLY_WINDOW_SECONDS = 7 * 86400;

/** Deterministic rotation through public-reply variants so it looks human. */
function pickRotating(texts: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts[h % texts.length]!;
}

/**
 * Hooks the caller (a tenant's Durable Object, or the self-host poller) uses to meter work, to
 * learn that Instagram is rate-limiting this account, and to stop the run when its send budget
 * is spent. All optional: the self-host path passes none and behaves as before.
 */
export interface EngineHooks {
  /** One outbound Graph call was attempted — any outcome. This is the metered `chatmany.send`. */
  onSendAttempt?(label: string): void;
  /** Instagram answered 429 / code 613 & friends: this account must cool down. */
  onRateLimit?(label: string): void;
  /** This comment will never accept a DM (2534001 & co) — dead-lettered, not retried. */
  onPermanentRefusal?(commentId: string, tag: string): void;
  /** Return true once the run's send budget is spent; the engine then stops attempting sends. */
  sendsExhausted?(): boolean;
}

/** Outcome of an opening attempt, as handleComment needs to see it. */
type OpeningResult = "sent" | "retry" | "permanent";

export class Engine {
  private readonly store: EngineStore;

  constructor(
    store: EngineStore | D1Database,
    private readonly client: InstagramClient,
    private readonly queue: SendQueue,
    private readonly hooks: EngineHooks = {},
  ) {
    // Back-compat: the self-host call sites hand in a raw D1Database, which is the 'self' tenant.
    this.store = isD1(store) ? new TenantDb(store, SELF_TENANT) : store;
  }

  // ---- comments ----

  /**
   * Handle a new comment: trigger match → opening DM → public actions. Idempotent per comment.
   * `activeCampaigns` may be passed by the caller (already fetched) to avoid a DB read per
   * comment; the webhook path omits it and we fetch on demand.
   */
  async handleComment(evt: NormalizedComment, activeCampaigns?: Campaign[]): Promise<void> {
    if (await this.store.isCommentProcessed(evt.comment_id)) return;
    if (!evt.igsid) return; // cannot correlate future messages without the commenter's IGSID

    const all = activeCampaigns ?? (await this.store.getActiveCampaigns());
    const campaigns = all.filter((c) => c.media_id === evt.media_id);
    let matchedCampaignId = "-";
    // A retryable opening-send failure leaves the comment unprocessed so the next pass retries it.
    let pendingRetry = false;

    for (const campaign of campaigns) {
      if (!commentTriggers(evt.text, campaign.keywords, campaign.exclude)) continue;
      matchedCampaignId = campaign.campaign_id;

      // Dedup DM: multiple comments from one person = exactly one opening DM per campaign.
      const existing = await this.store.getConversation(evt.igsid, campaign.campaign_id);
      if (existing) {
        await this.runPublicActions(campaign, evt);
        continue;
      }

      // Outside the 7-day private-reply window nothing can ever be sent: close the comment out.
      if (evt.timestamp > 0 && Date.now() / 1000 - evt.timestamp > PRIVATE_REPLY_WINDOW_SECONDS) {
        continue;
      }

      // DM FIRST, public reply only after it lands (2026-09-13 ghost reel: ~6,500 people saw a
      // public "sent" with no DM behind it, because the public reply was posted first and the
      // private reply then hit code 613).
      const result = await this.sendOpening(campaign, evt);
      if (result === "sent") await this.runPublicActions(campaign, evt);
      if (result === "retry") pendingRetry = true;
    }

    // Mark processed once nothing is awaiting retry, so we don't re-scan this comment every pass.
    if (!pendingRetry) await this.store.markCommentProcessed(evt.comment_id, evt.igsid, matchedCampaignId);
  }

  private async runPublicActions(campaign: Campaign, evt: NormalizedComment): Promise<void> {
    if (campaign.public_reply?.enabled && campaign.public_reply.texts.length > 0) {
      if (await this.store.claimCommentAction(evt.comment_id, "public_reply")) {
        const text = pickRotating(campaign.public_reply.texts, evt.comment_id);
        await this.trySend(() => this.client.replyToComment(evt.comment_id, text), "public_reply");
      }
    }
    // `like_comment` is intentionally not acted on: Instagram's API has no way to like a comment
    // (see the note in api/client.ts). The field is still accepted so older saved campaigns keep
    // loading, but it does nothing.
  }

  /**
   * Open the chat via a private reply to the comment. Either the delivery text itself
   * (`deliver_in_opening`, the ManyChat-parity mode) or a postback button (Step 1).
   */
  private async sendOpening(campaign: Campaign, evt: NormalizedComment): Promise<OpeningResult> {
    const key = `opening:${campaign.campaign_id}:${evt.comment_id}`;
    const direct = campaign.deliver_in_opening === true;
    const text = direct
      ? campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value)
      : campaign.copy.opening;

    const res = direct
      ? await this.attemptSend(() => this.client.privateReplyText(evt.comment_id, text), "opening_direct", key)
      : await this.attemptSend(
          () =>
            this.client.privateReplyWithButtons(evt.comment_id, text, [
              { type: "postback" as const, title: campaign.copy.opening_button ?? "Continue", payload: OPENING_PAYLOAD },
            ]),
          "opening",
          key,
        );

    if (!res.ok) {
      if (res.failure === "permanent") {
        this.hooks.onPermanentRefusal?.(evt.comment_id, res.tag);
        await this.refusalFallback(campaign, evt);
        return "permanent"; // dead-letter: the comment is marked processed, never retried
      }
      return "retry";
    }

    // Direct delivery creates the conversation already DONE — there is no tap to wait for.
    await this.store.createConversation(evt.igsid, campaign.campaign_id, evt.username ?? null, direct ? "DONE" : "AWAITING_TAP");
    const events: Array<{ campaignId: string; type: EventType; igsid: string | null }> = [
      { campaignId: campaign.campaign_id, type: "comment_matched", igsid: evt.igsid },
      { campaignId: campaign.campaign_id, type: "opening_sent", igsid: evt.igsid },
    ];
    if (direct) events.push({ campaignId: campaign.campaign_id, type: "delivered", igsid: evt.igsid });
    await this.store.logEvents(events);
    return "sent";
  }

  /**
   * When Instagram refuses to let us DM a commenter at all (they do not follow the account), say
   * so publicly and ask them to DM us the keyword — the inbound path below then answers them.
   * Live-verified 2026-09-16 (fix3). Off unless the campaign turns it on: a public reply on a
   * viral post is visible to thousands, and an unexplained one is the ghost-reel failure.
   */
  private async refusalFallback(campaign: Campaign, evt: NormalizedComment): Promise<void> {
    const fallback = campaign.refusal_fallback;
    if (!fallback?.enabled) return;
    if (!(await this.store.claimCommentAction(evt.comment_id, "refusal_fallback"))) return;
    const keyword = campaign.keywords[0] ?? "the keyword";
    const text = (fallback.text ?? "ig won't let me dm you first 😭 dm me the word {keyword} and i'll send the link")
      .replaceAll("{keyword}", keyword);
    await this.trySend(() => this.client.replyToComment(evt.comment_id, text), "refusal_fallback");
  }

  // ---- messages ----

  /**
   * Handle an inbound message: advance any of this person's open conversations. In polling mode
   * the hidden payload is often unavailable, so taps are resolved by matching the message text to
   * the expected button title for the current state (and, for AWAITING_TAP, any inbound message
   * counts — the opening postback posts no visible text; webhook mode also delivers the payload).
   */
  async handleMessage(evt: NormalizedMessage, activeCampaigns?: Campaign[]): Promise<void> {
    const open = await this.store.getOpenConversations(evt.igsid);
    for (const convo of open) {
      // Idempotency: only act on a message that arrived after our last transition, so re-reads of
      // the same message in the conversation history don't advance the funnel twice.
      if (evt.timestamp <= convo.updated_at) continue;

      const campaign = await this.store.getCampaign(convo.campaign_id);
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
    if (open.length === 0) await this.answerInboundKeyword(evt, activeCampaigns);
  }

  /**
   * Inbound-first delivery (fix3, live-verified 12/12 at a 44s median): someone who was never
   * DM-able writes us the keyword themselves, which opens a Send API window that does NOT have
   * the private-reply restriction. One reward per person per campaign.
   */
  private async answerInboundKeyword(evt: NormalizedMessage, activeCampaigns?: Campaign[]): Promise<void> {
    const text = evt.text;
    if (!text) return;
    const campaigns = activeCampaigns ?? (await this.store.getActiveCampaigns());
    for (const campaign of campaigns) {
      if (!commentTriggers(text, campaign.keywords, campaign.exclude)) continue;
      const key = `inbound:${campaign.campaign_id}:${evt.igsid}`;
      const body = campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value);
      const res = await this.attemptSend(() => this.client.sendText(evt.igsid, body), "inbound_reward", key);
      if (!res.ok) return;
      await this.store.createConversation(evt.igsid, campaign.campaign_id, null, "DONE");
      await this.store.logEvents([
        { campaignId: campaign.campaign_id, type: "comment_matched", igsid: evt.igsid },
        { campaignId: campaign.campaign_id, type: "delivered", igsid: evt.igsid },
      ]);
      return; // one reward per inbound message
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
      await this.store.updateConversation(igsid, campaign.campaign_id, { state: "AWAITING_EMAIL" });
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
      await this.store.updateConversation(igsid, campaign.campaign_id, { state: restingState, ...opts.patch });
      const events: Array<{ campaignId: string; type: EventType; igsid: string | null }> = [];
      if (opts.entryEvent) events.push({ campaignId: campaign.campaign_id, type: opts.entryEvent, igsid });
      if (extra) events.push({ campaignId: campaign.campaign_id, type: extra, igsid });
      await this.store.logEvents(events);
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
        const text = campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value);
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
      await this.store.updateConversation(igsid, campaign.campaign_id, { follow_retries: retries + 1 });
    }
  }

  // ---- verify_follow_count helpers (weak heuristic) ----

  private baselineKey(campaign: Campaign, igsid: string): string {
    return `follow_baseline:${campaign.campaign_id}:${igsid}`;
  }

  private async captureFollowerBaseline(campaign: Campaign, igsid: string): Promise<void> {
    try {
      const count = await this.client.getFollowersCount();
      if (count !== undefined) await this.store.kvSet(this.baselineKey(campaign, igsid), String(count));
    } catch {
      // best-effort; absence just means we fail open on confirm
    }
  }

  private async followerCountGrew(campaign: Campaign, igsid: string): Promise<boolean> {
    const baselineRaw = await this.store.kvGet(this.baselineKey(campaign, igsid));
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
   * Run a send through the queue, at most once per `key`, and report WHY it failed.
   *
   * Sends are claimed before they go out. The outcome of a failed send is not always knowable:
   * a timeout, dropped connection, or 5xx can all arrive *after* Instagram already delivered the
   * message. Treating those as "never happened" and retrying is what showed 8 people the same DM
   * up to 26 times on 2026-08-23, so instead:
   *
   *   - no answer at all, or a 5xx / code 1 / code 2 → UNKNOWN outcome: keep the claim, report
   *     success, and never retry (see engine/failure.ts);
   *   - rate limited (429, 613, …) → nothing was delivered: release the claim, tell the caller to
   *     cool this account down, and retry on a later pass;
   *   - permanently refused (2534001 & co) → nothing was delivered and nothing ever will be:
   *     release the claim and let the caller dead-letter it;
   *   - any other 4xx → nothing was delivered: release the claim and retry later;
   *   - claim already held → a previous attempt got far enough to send, so skip and report
   *     success. This is what catches a retry after the Worker died mid-send.
   *
   * The trade is deliberate: at-most-once delivery. A genuinely lost message leaves that person
   * where they were instead of being messaged again.
   */
  private async attemptSend<T>(
    fn: () => Promise<T>,
    label: string,
    key?: string,
  ): Promise<{ ok: true } | { ok: false; failure: SendFailure; tag: string }> {
    // Budget check comes before the claim: a send we never attempt must not hold a claim, or the
    // person would be marked as already-messaged and never hear from us.
    if (this.hooks.sendsExhausted?.()) {
      return { ok: false, failure: "refused", tag: "budget" };
    }
    const claimKey = key ?? null;
    if (claimKey && !(await this.store.claimSend(claimKey))) {
      console.warn(`[chatmany] skipping ${label}: already attempted, may have delivered (${claimKey})`);
      return { ok: true };
    }
    try {
      this.hooks.onSendAttempt?.(label);
      await this.queue.run(fn);
      return { ok: true };
    } catch (e) {
      const failure = classifySendFailure(e);
      const tag = failureTag(e);
      if (failure === "ambiguous") {
        console.warn(
          `[chatmany] send outcome unknown (${label}, ${tag}) — treating as delivered so it is not sent twice`,
        );
        return claimKey ? { ok: true } : { ok: false, failure, tag };
      }
      if (claimKey) await this.store.releaseSend(claimKey);
      if (failure === "rate_limited") this.hooks.onRateLimit?.(label);
      console.warn(`[chatmany] send failed (${label}, ${failure}, ${tag})`);
      return { ok: false, failure, tag };
    }
  }

  /** Boolean form of attemptSend, for the call sites that only branch on success. */
  private async trySend<T>(fn: () => Promise<T>, label: string, key?: string): Promise<boolean> {
    return (await this.attemptSend(fn, label, key)).ok;
  }
}

function isD1(v: EngineStore | D1Database): v is D1Database {
  return typeof (v as D1Database).prepare === "function";
}
