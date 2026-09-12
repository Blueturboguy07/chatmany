// A fake TikTokClient that records calls and can be told to refuse / rate-limit / ambiguously fail
// the next N calls of a method. Cast to TikTokClient when constructing the TikTokEngine.

import { TikTokApiError } from "../../src/api/tiktok";
import type { TikTokClient, TtComment } from "../../src/api/tiktok";

type Method = "reply" | "text" | "qa";

export class FakeTikTokClient {
  calls: Record<Method, unknown[]> = { reply: [], text: [], qa: [] };
  /** Refuse (definite 4xx-style API error, nothing sent) the next N calls. */
  failNext: Partial<Record<Method, number>> = {};
  /** Rate-limit (code 40100) the next N calls. */
  rateLimitNext: Partial<Record<Method, number>> = {};
  /** Deliver, then throw a 5xx (ambiguous outcome) on the next N calls. */
  deliverThenFail5xxNext: Partial<Record<Method, number>> = {};
  /** Comments returned by getComments (webhook read-back). */
  comments: TtComment[] = [];
  readonly businessId = "biz_1";

  private guard(m: Method): void {
    const rl = this.rateLimitNext[m] ?? 0;
    if (rl > 0) {
      this.rateLimitNext[m] = rl - 1;
      throw new TikTokApiError("rate limited", 200, 40100);
    }
    const n = this.failNext[m] ?? 0;
    if (n > 0) {
      this.failNext[m] = n - 1;
      throw new TikTokApiError("param error", 200, 40002);
    }
  }
  private guardAfter(m: Method): void {
    const n = this.deliverThenFail5xxNext[m] ?? 0;
    if (n > 0) {
      this.deliverThenFail5xxNext[m] = n - 1;
      throw new TikTokApiError("system error", 500, 51065);
    }
  }

  async replyToComment(videoId: string, commentId: string, text: string) {
    this.guard("reply");
    this.calls.reply.push({ videoId, commentId, text });
    this.guardAfter("reply");
    return { comment_id: `r_${commentId}` };
  }
  async sendText(conversationId: string, body: string) {
    this.guard("text");
    this.calls.text.push({ conversationId, body });
    this.guardAfter("text");
    return { message: { message_id: `m_${this.calls.text.length}` } };
  }
  async sendQaButtons(conversationId: string, title: string, buttons: { title: string; id: string }[]) {
    this.guard("qa");
    this.calls.qa.push({ conversationId, title, buttons });
    this.guardAfter("qa");
    return { message: { message_id: `q_${this.calls.qa.length}` } };
  }
  async getComments(_videoId: string, ids: string[]) {
    return this.comments.filter((c) => ids.includes(c.comment_id));
  }
  async listComments() {
    return { comments: this.comments, hasMore: false };
  }
  async listVideos() {
    return [];
  }
  async listConversations() {
    return [];
  }
  async listMessages() {
    return { messages: [], participants: [] };
  }
  async getProfile() {
    return { username: "biz" };
  }

  asClient(): TikTokClient {
    return this as unknown as TikTokClient;
  }
}
