import { beforeEach, describe, expect, it } from "vitest";
import { TikTokEngine, TT_FOLLOW_PAYLOAD, renderNudge } from "../src/engine/tiktokEngine";
import { SendQueue } from "../src/queue/queue";
import { eventCountsByType, getActiveCampaigns, getConversation, isCommentProcessed, upsertCampaign } from "../src/db";
import type { Campaign, NormalizedComment, NormalizedMessage } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeTikTokClient } from "./helpers/fakeTikTokClient";

const fastQueue = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });
const T = Math.floor(Date.now() / 1000);

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "tt1",
    platform: "tiktok",
    name: "SurfCam",
    media_id: "7300000000000000001",
    keywords: ["SURF", "surfcam"],
    exclude: [],
    reward: { type: "link", value: "https://publikhq.com/surfcam" },
    copy: {
      opening: 'DM me "{keyword}" and I\'ll send you the link 📩',
      follow_gate: "Follow first 🙌",
      follow_button: "✅ I followed",
      email_ask: "your email?",
      delivery: "here you go {reward}",
    },
    ...over,
  };
}

function comment(over: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    comment_id: "c1",
    igsid: "uid_a",
    username: "alice",
    text: "SURF pls",
    media_id: "7300000000000000001",
    timestamp: T,
    ...over,
  };
}

function dm(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: "message",
    igsid: "uid_a",
    text: "surf",
    timestamp: T + 100,
    conversation_id: "conv_a",
    username: "alice",
    message_id: "m1",
    ...over,
  };
}

let db: D1Database;
let client: FakeTikTokClient;
let engine: TikTokEngine;

beforeEach(async () => {
  db = await makeTestDb();
  client = new FakeTikTokClient();
  engine = new TikTokEngine(db, client.asClient(), fastQueue());
  await upsertCampaign(db, campaign(), true);
});

describe("platform separation", () => {
  it("TikTok campaigns are invisible to the Instagram poller and vice versa", async () => {
    await upsertCampaign(db, campaign({ campaign_id: "ig1", platform: "instagram", media_id: "ig_media" }), true);
    expect((await getActiveCampaigns(db, "instagram")).map((c) => c.campaign_id)).toEqual(["ig1"]);
    expect((await getActiveCampaigns(db, "tiktok")).map((c) => c.campaign_id)).toEqual(["tt1"]);
    expect((await getActiveCampaigns(db)).map((c) => c.campaign_id)).toEqual(["ig1"]); // default = Instagram
  });
});

describe("comment → public nudge", () => {
  it("replies under a matching comment with the keyword filled in and opens AWAITING_DM", async () => {
    await engine.handleComment(comment());
    expect(client.calls.reply).toEqual([
      { videoId: "7300000000000000001", commentId: "c1", text: 'DM me "SURF" and I\'ll send you the link 📩' },
    ]);
    const convo = await getConversation(db, "uid_a", "tt1");
    expect(convo?.state).toBe("AWAITING_DM");
    expect(convo?.conversation_id).toBeNull();
    expect(await isCommentProcessed(db, "c1")).toBe(true);
    const counts = await eventCountsByType(db, "tt1", 0);
    expect(counts.comment_matched).toBe(1);
    expect(counts.opening_sent).toBe(1);
    expect(counts.delivered).toBe(0);
  });

  it("ignores comments without the keyword, and on other videos", async () => {
    await engine.handleComment(comment({ text: "cool video" }));
    await engine.handleComment(comment({ comment_id: "c2", media_id: "other" }));
    expect(client.calls.reply).toHaveLength(0);
    expect(await getConversation(db, "uid_a", "tt1")).toBeNull();
  });

  it("rotates the public-reply variants when enabled instead of the opening copy", async () => {
    await upsertCampaign(db, campaign({ public_reply: { enabled: true, texts: ["A {keyword}", "B {keyword}"] } }), true);
    await engine.handleComment(comment());
    expect(["A SURF", "B SURF"]).toContain((client.calls.reply[0] as { text: string }).text);
    expect(renderNudge(campaign(), "x")).toBe('DM me "SURF" and I\'ll send you the link 📩');
  });

  it("a refused nudge leaves the comment unprocessed so the next delivery retries it", async () => {
    client.failNext.reply = 1;
    await engine.handleComment(comment());
    expect(await isCommentProcessed(db, "c1")).toBe(false);
    expect(await getConversation(db, "uid_a", "tt1")).toBeNull();
    await engine.handleComment(comment());
    expect(client.calls.reply).toHaveLength(1);
    expect(await isCommentProcessed(db, "c1")).toBe(true);
  });

  it("an ambiguous (5xx) nudge failure is treated as delivered and never re-sent", async () => {
    client.deliverThenFail5xxNext.reply = 1;
    await engine.handleComment(comment());
    expect(await isCommentProcessed(db, "c1")).toBe(true);
    await engine.handleComment(comment());
    expect(client.calls.reply).toHaveLength(1);
  });

  it("does not nag someone already past the nudge", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm());
    await engine.handleComment(comment({ comment_id: "c2" }));
    expect(client.calls.reply).toHaveLength(1);
    expect(await isCommentProcessed(db, "c2")).toBe(true);
  });
});

describe("DM → delivery", () => {
  it("delivers when the nudged person DMs the keyword", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm());
    expect(client.calls.text).toEqual([{ conversationId: "conv_a", body: "here you go https://publikhq.com/surfcam" }]);
    const convo = await getConversation(db, "uid_a", "tt1");
    expect(convo?.state).toBe("DONE");
    expect(convo?.conversation_id).toBe("conv_a");
    const counts = await eventCountsByType(db, "tt1", 0);
    expect(counts.button_clicked).toBe(1);
    expect(counts.delivered).toBe(1);
  });

  it("delivers even when the DM arrives before the (late) comment webhook", async () => {
    // Comment webhooks can lag 5 minutes; the DM timestamp predates the row's updated_at.
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ timestamp: T - 200 }));
    expect(client.calls.text).toHaveLength(1);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("DONE");
  });

  it("any DM counts when it is the person's only pending funnel", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ text: "hey can i get it" }));
    expect(client.calls.text).toHaveLength(1);
  });

  it("without a keyword and with two pending funnels it waits", async () => {
    await upsertCampaign(db, campaign({ campaign_id: "tt2", keywords: ["DRIP"], media_id: "7300000000000000002" }), true);
    await engine.handleComment(comment());
    await engine.handleComment(comment({ comment_id: "c9", media_id: "7300000000000000002", text: "DRIP" }));
    await engine.handleMessage(dm({ text: "hello?" }));
    expect(client.calls.text).toHaveLength(0);
    await engine.handleMessage(dm({ text: "drip", message_id: "m2", timestamp: T + 101 }));
    expect(client.calls.text).toEqual([{ conversationId: "conv_a", body: "here you go https://publikhq.com/surfcam" }]);
    expect((await getConversation(db, "uid_a", "tt2"))?.state).toBe("DONE");
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_DM");
  });

  it("a keyword DM with no prior comment enters the funnel and is delivered", async () => {
    await engine.handleMessage(dm({ igsid: "uid_b", conversation_id: "conv_b", username: "bob" }));
    expect(client.calls.text).toEqual([{ conversationId: "conv_b", body: "here you go https://publikhq.com/surfcam" }]);
    const convo = await getConversation(db, "uid_b", "tt1");
    expect(convo?.state).toBe("DONE");
    expect(convo?.username).toBe("bob");
    const counts = await eventCountsByType(db, "tt1", 0);
    expect(counts.comment_matched).toBe(0);
    expect(counts.button_clicked).toBe(1);
    expect(counts.delivered).toBe(1);
  });

  it("someone already served who asks again gets the link again, once per message", async () => {
    await engine.handleMessage(dm());
    await engine.handleMessage(dm({ message_id: "m2", timestamp: T + 500 }));
    await engine.handleMessage(dm({ message_id: "m2", timestamp: T + 500 })); // webhook retry
    expect(client.calls.text).toHaveLength(2);
    expect((await eventCountsByType(db, "tt1", 0)).delivered).toBe(2);
  });

  it("a DM without a conversation id (nothing to reply into) is ignored", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ conversation_id: undefined }));
    expect(client.calls.text).toHaveLength(0);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_DM");
  });

  it("a refused delivery keeps the funnel open for a retry; a 5xx does not double-send", async () => {
    await engine.handleComment(comment());
    client.failNext.text = 1;
    await engine.handleMessage(dm());
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_DM");
    client.deliverThenFail5xxNext.text = 1;
    await engine.handleMessage(dm({ message_id: "m2", timestamp: T + 101 }));
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("DONE");
    expect(client.calls.text).toHaveLength(1);
    await engine.handleMessage(dm({ message_id: "m2", timestamp: T + 101 })); // retry of the same message
    expect(client.calls.text).toHaveLength(1);
  });

  it("rate limiting is a refusal: the send is retried on the next delivery", async () => {
    await engine.handleComment(comment());
    client.rateLimitNext.text = 1;
    await engine.handleMessage(dm());
    expect(client.calls.text).toHaveLength(0);
    await engine.handleMessage(dm());
    expect(client.calls.text).toHaveLength(1);
  });
});

describe("follow gate (Q&A card + is_follower)", () => {
  beforeEach(async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
  });

  it("skips the gate entirely when TikTok says they already follow", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ is_follower: true }));
    expect(client.calls.qa).toHaveLength(0);
    expect(client.calls.text).toHaveLength(1);
    const counts = await eventCountsByType(db, "tt1", 0);
    expect(counts.follow_confirmed).toBe(1);
    expect(counts.delivered).toBe(1);
    expect((await getConversation(db, "uid_a", "tt1"))?.followed).toBe(1);
  });

  it("sends a Q&A button card when they don't follow, then delivers on the tap once they do", async () => {
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ is_follower: false }));
    expect(client.calls.qa).toEqual([
      { conversationId: "conv_a", title: "Follow first 🙌", buttons: [{ title: "✅ I followed", id: TT_FOLLOW_PAYLOAD }] },
    ]);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_FOLLOW");

    // Tap while still not following: gate re-sent, state unchanged.
    await engine.handleMessage(dm({ text: "✅ I followed", payload: TT_FOLLOW_PAYLOAD, is_follower: false, timestamp: T + 200, message_id: "m2" }));
    expect(client.calls.qa).toHaveLength(2);
    expect(client.calls.text).toHaveLength(0);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_FOLLOW");

    // Tap after following: delivered.
    await engine.handleMessage(dm({ text: "✅ I followed", payload: TT_FOLLOW_PAYLOAD, is_follower: true, timestamp: T + 300, message_id: "m3" }));
    expect(client.calls.text).toEqual([{ conversationId: "conv_a", body: "here you go https://publikhq.com/surfcam" }]);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("DONE");
  });

  it("long gate copy goes out as text plus a short card, and a typed confirmation works without the button id", async () => {
    await upsertCampaign(db, campaign({ check_follow: true, copy: { ...campaign().copy, follow_gate: "Follow us first so you don't miss the next drop 🙌" } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(dm({ is_follower: false }));
    expect(client.calls.text).toEqual([{ conversationId: "conv_a", body: "Follow us first so you don't miss the next drop 🙌" }]);
    expect((client.calls.qa[0] as { title: string }).title).toBe("Tap once you've followed");
    await engine.handleMessage(dm({ text: "i followed", is_follower: true, timestamp: T + 200, message_id: "m2" }));
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_FOLLOW"); // not the button title
    await engine.handleMessage(dm({ text: "✅ I followed", is_follower: true, timestamp: T + 300, message_id: "m3" }));
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("DONE");
  });
});

describe("email gate", () => {
  it("asks for the email as text, re-asks on junk, delivers on a valid address", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(dm());
    expect(client.calls.text).toEqual([{ conversationId: "conv_a", body: "your email?" }]);
    expect((await getConversation(db, "uid_a", "tt1"))?.state).toBe("AWAITING_EMAIL");
    await engine.handleMessage(dm({ text: "what", timestamp: T + 200, message_id: "m2" }));
    expect(client.calls.text).toHaveLength(2);
    await engine.handleMessage(dm({ text: "alice@example.com", timestamp: T + 300, message_id: "m3" }));
    const convo = await getConversation(db, "uid_a", "tt1");
    expect(convo?.state).toBe("DONE");
    expect(convo?.email).toBe("alice@example.com");
    expect(client.calls.text[2]).toEqual({ conversationId: "conv_a", body: "here you go https://publikhq.com/surfcam" });
  });
});
