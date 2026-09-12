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
  /** How many upcoming calls of each method should throw a (non-rate-limit) error. */
  failNext: Partial<Record<Method, number>> = {};
  /**
   * How many upcoming calls of each method should DELIVER and then throw — i.e. Instagram
   * accepted and sent the message, but we never learned that (timeout, dropped connection,
   * 5xx after processing). The call is recorded before the throw, so `calls` reflects what
   * the recipient actually received. This is the case that produces real duplicate DMs.
   */
  deliverThenFailNext: Partial<Record<Method, number>> = {};
  followers = 100;

  /**
   * How many upcoming calls of each method should DELIVER and then throw a 5xx InstagramApiError
   * — Instagram's real behaviour for private replies: it sends the message and still answers
   * `HTTP 500 / code 1 "An unknown error has occurred."`. Like deliverThenFailNext, the call is
   * recorded before the throw, because the recipient really did receive it.
   */
  deliverThenFail5xxNext: Partial<Record<Method, number>> = {};

  /** How many upcoming calls of each method should be refused with a 429 rate limit. */
  rateLimitNext: Partial<Record<Method, number>> = {};

  private guard(m: Method): void {
    const rl = this.rateLimitNext[m] ?? 0;
    if (rl > 0) {
      this.rateLimitNext[m] = rl - 1;
      throw new InstagramApiError("rate limited", 429, 4);
    }
    const n = this.failNext[m] ?? 0;
    if (n > 0) {
      this.failNext[m] = n - 1;
      // A 4xx: Instagram refused the request outright, so nothing was sent and a retry is safe.
      throw new InstagramApiError("simulated refusal", 400, 100);
    }
  }

  /** Call AFTER recording the call, to simulate a delivered-but-errored send. */
  private guardAfter(m: Method): void {
    const n = this.deliverThenFailNext[m] ?? 0;
    if (n > 0) {
      this.deliverThenFailNext[m] = n - 1;
      // Deliberately NOT an InstagramApiError: this models the connection dropping after
      // Instagram already accepted the send, so we never receive a status at all.
      throw new Error("socket hang up");
    }
    const n5 = this.deliverThenFail5xxNext[m] ?? 0;
    if (n5 > 0) {
      this.deliverThenFail5xxNext[m] = n5 - 1;
      throw new InstagramApiError("An unknown error has occurred.", 500, 1);
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
  async getFollowersCount() {
    this.calls.followers.push({});
    return this.followers;
  }

  asClient(): InstagramClient {
    return this as unknown as InstagramClient;
  }
}
