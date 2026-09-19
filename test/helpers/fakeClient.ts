// A fake InstagramClient that records calls and can be told to fail the next N calls of a method
// (to exercise send-failure retry paths). Cast to InstagramClient when constructing the Engine.

import { InstagramApiError } from "../../src/api/client";
import type { InstagramClient } from "../../src/api/client";

type Method = "privateReply" | "privateReplyText" | "reply" | "like" | "quick" | "text" | "followers";

export class FakeClient {
  calls: Record<Method, unknown[]> = {
    privateReply: [],
    privateReplyText: [],
    reply: [],
    like: [],
    quick: [],
    text: [],
    followers: [],
  };
  /**
   * How many upcoming calls of each method should be REFUSED by Instagram — a 4xx, meaning the
   * request reached Instagram and nothing was delivered, so retrying is safe.
   *
   * This used to be a 500. It cannot be: a 5xx is an unknown outcome and often arrives after the
   * message was delivered (2026-08-23, 116 duplicate DMs). Use deliverThenFail5xxNext for that.
   */
  failNext: Partial<Record<Method, number>> = {};
  /**
   * How many upcoming calls should DELIVER and then answer HTTP 500 / code 1 — Instagram sent the
   * message and told us it failed. The call is recorded before the throw, so `calls` reflects what
   * the recipient actually received. Retrying this is what produces real duplicate DMs.
   */
  deliverThenFail5xxNext: Partial<Record<Method, number>> = {};
  /** How many upcoming calls should be rate-limited (code 613, the viral-reel failure). */
  rateLimitNext: Partial<Record<Method, number>> = {};
  /** How many upcoming calls should be permanently refused (code 100 / subcode 2534001). */
  permanentRefusalNext: Partial<Record<Method, number>> = {};
  /**
   * How many upcoming calls of each method should DELIVER and then throw — i.e. Instagram
   * accepted and sent the message, but we never learned that (timeout, dropped connection,
   * 5xx after processing). The call is recorded before the throw, so `calls` reflects what
   * the recipient actually received. This is the case that produces real duplicate DMs.
   */
  deliverThenFailNext: Partial<Record<Method, number>> = {};
  followers = 100;

  private guard(m: Method): void {
    const rl = this.rateLimitNext[m] ?? 0;
    if (rl > 0) {
      this.rateLimitNext[m] = rl - 1;
      throw new InstagramApiError("(#613) Calls to this api have exceeded the rate limit", 400, 613);
    }
    const perm = this.permanentRefusalNext[m] ?? 0;
    if (perm > 0) {
      this.permanentRefusalNext[m] = perm - 1;
      throw new InstagramApiError(
        "The thread owner has archived or deleted this conversation, or the thread does not exist",
        400,
        100,
        2534001,
      );
    }
    const n = this.failNext[m] ?? 0;
    if (n > 0) {
      this.failNext[m] = n - 1;
      throw new InstagramApiError("simulated failure", 400);
    }
  }

  /** Call AFTER recording the call, to simulate a delivered-but-errored send. */
  private guardAfter(m: Method): void {
    const five = this.deliverThenFail5xxNext[m] ?? 0;
    if (five > 0) {
      this.deliverThenFail5xxNext[m] = five - 1;
      // Instagram delivered the message and answered HTTP 500 / code 1 anyway.
      throw new InstagramApiError("An unknown error has occurred.", 500, 1);
    }
    const n = this.deliverThenFailNext[m] ?? 0;
    if (n > 0) {
      this.deliverThenFailNext[m] = n - 1;
      // Deliberately NOT an InstagramApiError: this models the connection dropping after
      // Instagram already accepted the send, so we never receive a status at all.
      throw new Error("socket hang up");
    }
  }

  async privateReplyWithButtons(commentId: string, text: string, buttons: unknown) {
    this.guard("privateReply");
    this.calls.privateReply.push({ commentId, text, buttons });
    this.guardAfter("privateReply");
    return { message_id: "m" };
  }
  async privateReplyText(commentId: string, text: string) {
    this.guard("privateReplyText");
    this.calls.privateReplyText.push({ commentId, text });
    this.guardAfter("privateReplyText");
    return { message_id: "m" };
  }
  async replyToComment(commentId: string, message: string) {
    this.guard("reply");
    this.calls.reply.push({ commentId, message });
    return { id: "r" };
  }
  // Deliberately still present so the test above can assert it is NEVER called. The real
  // InstagramClient has no likeComment() — Instagram's API cannot like a comment.
  async likeComment(commentId: string) {
    this.guard("like");
    this.calls.like.push({ commentId });
    return { success: true };
  }
  async sendQuickReplies(igsid: string, text: string, quickReplies: unknown) {
    this.guard("quick");
    this.calls.quick.push({ igsid, text, quickReplies });
    this.guardAfter("quick");
    return { message_id: "m" };
  }
  async sendText(igsid: string, text: string) {
    this.guard("text");
    this.calls.text.push({ igsid, text });
    this.guardAfter("text");
    return { message_id: "m" };
  }
  /**
   * Pages of comments per media, as Instagram would return them (newest first). Set with
   * `seedComments`. `getCommentsPage` walks them with an opaque cursor, so the backlog sweep can
   * be tested end to end.
   */
  pages: Record<string, Array<Array<{ id: string; text: string; from: { id: string; username?: string }; timestamp?: string }>>> = {};
  /** Inbound conversations for the polling path. */
  conversations: Array<{ id: string; messages?: { data?: Array<{ id?: string; from?: { id: string }; message?: string; created_time?: string }> } }> = [];

  seedComments(mediaId: string, pages: Array<Array<{ id: string; text: string; igsid: string }>>): void {
    this.pages[mediaId] = pages.map((p) =>
      p.map((c) => ({ id: c.id, text: c.text, from: { id: c.igsid, username: c.igsid }, timestamp: new Date().toISOString() })),
    );
  }

  async getCommentsPage(mediaId: string, _limit = 50, after?: string) {
    const pages = this.pages[mediaId] ?? [];
    const idx = after ? Number(after) : 0;
    const page = pages[idx] ?? [];
    const next = idx + 1 < pages.length ? String(idx + 1) : undefined;
    return { comments: page, next };
  }

  async getComments(mediaId: string, _limit = 50) {
    return (this.pages[mediaId] ?? [])[0] ?? [];
  }

  async getConversations(_limit = 20) {
    return this.conversations;
  }

  async getFollowersCount() {
    this.calls.followers.push({});
    return this.followers;
  }

  asClient(): InstagramClient {
    return this as unknown as InstagramClient;
  }
}
