// Regressions for every send-outcome class in the field record. Each test names the incident it
// exists to prevent.

import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { classifySendFailure } from "../src/engine/failure";
import { InstagramApiError } from "../src/api/client";
import { eventCountsByType, getConversation, upsertCampaign } from "../src/db";
import type { Campaign, NormalizedComment } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const fastQueue = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });
const T = Math.floor(Date.now() / 1000);

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    name: "Test",
    media_id: "media1",
    keywords: ["Link"],
    exclude: [],
    reward: { type: "link", value: "https://publikhq.com/x" },
    copy: { opening: "tap 👇", opening_button: "Send it", delivery: "here you go {reward}" },
    ...over,
  };
}

function comment(over: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    comment_id: "cm1",
    igsid: "user1",
    username: "user1",
    text: "Link please",
    media_id: "media1",
    timestamp: T,
    ...over,
  };
}

let db: D1Database;
let client: FakeClient;

beforeEach(() => {
  db = makeTestDb();
  client = new FakeClient();
});

describe("classifySendFailure", () => {
  it("a 5xx is an UNKNOWN outcome, not a refusal (2026-08-23: 116 duplicate DMs)", () => {
    expect(classifySendFailure(new InstagramApiError("An unknown error has occurred.", 500, 1))).toBe("ambiguous");
    expect(classifySendFailure(new InstagramApiError("bad gateway", 502))).toBe("ambiguous");
  });
  it("Meta's generic code 1/2 on any status is also unknown", () => {
    expect(classifySendFailure(new InstagramApiError("unknown", 400, 2))).toBe("ambiguous");
  });
  it("a network throw with no HTTP answer is unknown", () => {
    expect(classifySendFailure(new Error("socket hang up"))).toBe("ambiguous");
  });
  it("code 613 and 429 are rate limits (nothing was sent)", () => {
    expect(classifySendFailure(new InstagramApiError("rate limit", 400, 613))).toBe("rate_limited");
    expect(classifySendFailure(new InstagramApiError("too many", 429))).toBe("rate_limited");
  });
  it("subcode 2534001 is permanent (non-follower / deleted thread)", () => {
    expect(classifySendFailure(new InstagramApiError("archived", 400, 100, 2534001))).toBe("permanent");
    expect(classifySendFailure(new InstagramApiError("The requested user cannot be found.", 400, 100))).toBe(
      "permanent",
    );
  });
  it("an ordinary 4xx is a refusal and may be retried", () => {
    expect(classifySendFailure(new InstagramApiError("bad request", 400, 100, 33))).toBe("refused");
  });
});

describe("never retry a send whose outcome is unknown (2026-08-23 duplicate-DM incident)", () => {
  it("delivers once when Instagram answers 500 after delivering, across 25 re-polls", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign(), true);
    client.deliverThenFail5xxNext.privateReply = 1;

    for (let i = 0; i < 25; i++) await engine.handleComment(comment());

    // One send, ever. The claim is kept because the message may well be in their inbox.
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("a rate-limited send is NOT claimed away: it retries and lands once the limit clears", async () => {
    const seen: string[] = [];
    const engine = new Engine(db, client.asClient(), fastQueue(), {
      onRateLimit: (label) => seen.push(label),
    });
    await upsertCampaign(db, campaign(), true);
    client.rateLimitNext.privateReply = 1;

    await engine.handleComment(comment()); // 613 — nothing delivered
    expect(await getConversation(db, "user1", "c1")).toBeNull();
    expect(seen).toEqual(["opening"]); // the caller is told to cool this account down

    await engine.handleComment(comment()); // the retry lands (the 613 attempt never reached anyone)
    expect(client.calls.privateReply).toHaveLength(1);
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_TAP");
  });
});

describe("permanent refusals are dead-lettered (2026-09-15 ghost reel)", () => {
  it("a 2534001 comment is attempted once and never again", async () => {
    const refused: string[] = [];
    const engine = new Engine(db, client.asClient(), fastQueue(), {
      onPermanentRefusal: (commentId) => refused.push(commentId),
    });
    await upsertCampaign(db, campaign(), true);
    client.permanentRefusalNext.privateReply = 5;

    for (let i = 0; i < 5; i++) await engine.handleComment(comment());

    expect(client.calls.privateReply).toHaveLength(0); // the send never got past Instagram
    expect(refused).toEqual(["cm1"]); // reported once, then marked processed
  });

  it("posts the 'dm me the keyword' public reply only when the campaign asks for it", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign({ refusal_fallback: { enabled: true } }), true);
    client.permanentRefusalNext.privateReply = 1;

    await engine.handleComment(comment());
    expect(client.calls.reply).toHaveLength(1);
    expect(String((client.calls.reply[0] as { message: string }).message)).toContain("Link");

    // ...and never again for the same comment.
    await engine.handleComment(comment());
    expect(client.calls.reply).toHaveLength(1);
  });
});

describe("public reply only after the DM lands (2026-09-13: ~6,500 public 'sent' with no DM)", () => {
  it("does not post the public reply when the private reply was refused", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign({ public_reply: { enabled: true, texts: ["sent"] } }), true);
    client.permanentRefusalNext.privateReply = 1;

    await engine.handleComment(comment());
    expect(client.calls.reply).toHaveLength(0);
  });

  it("posts it once the private reply succeeded", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign({ public_reply: { enabled: true, texts: ["sent"] } }), true);

    await engine.handleComment(comment());
    expect(client.calls.privateReply).toHaveLength(1);
    expect(client.calls.reply).toHaveLength(1);
  });
});

describe("deliver_in_opening (ManyChat parity, live 2026-08-23)", () => {
  it("sends one plain private reply carrying the link and finishes the funnel", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign({ deliver_in_opening: true }), true);

    await engine.handleComment(comment());

    expect(client.calls.privateReply).toHaveLength(0); // no button template
    expect(client.calls.privateReplyText).toHaveLength(1);
    expect((client.calls.privateReplyText[0] as { text: string }).text).toBe("here you go https://publikhq.com/x");
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("DONE");
    const c = await eventCountsByType(db, "c1", 0);
    expect(c.delivered).toBe(1);
  });
});

describe("the 7-day private-reply window", () => {
  it("an older comment is closed out instead of being retried forever", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign(), true);

    await engine.handleComment(comment({ timestamp: T - 8 * 86400 }));
    expect(client.calls.privateReply).toHaveLength(0);

    // Marked processed: a later pass does not look at it again.
    await engine.handleComment(comment({ timestamp: T - 8 * 86400 }));
    expect(client.calls.privateReply).toHaveLength(0);
  });
});

describe("per-run send budget", () => {
  it("a send refused by the budget holds no claim, so the next run still delivers it", async () => {
    let exhausted = true;
    const engine = new Engine(db, client.asClient(), fastQueue(), { sendsExhausted: () => exhausted });
    await upsertCampaign(db, campaign(), true);

    await engine.handleComment(comment());
    expect(client.calls.privateReply).toHaveLength(0);

    exhausted = false;
    await engine.handleComment(comment());
    expect(client.calls.privateReply).toHaveLength(1);
  });
});

describe("inbound-first delivery (fix3, live-verified 12/12)", () => {
  it("answers someone who DMs the keyword, once", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign({ deliver_in_opening: true }), true);

    await engine.handleMessage({ kind: "message", igsid: "user9", text: "link", timestamp: T + 10 });
    expect(client.calls.text).toHaveLength(1);
    expect((client.calls.text[0] as { text: string }).text).toBe("here you go https://publikhq.com/x");

    await engine.handleMessage({ kind: "message", igsid: "user9", text: "link", timestamp: T + 20 });
    expect(client.calls.text).toHaveLength(1);
  });

  it("ignores an inbound message that matches nothing", async () => {
    const engine = new Engine(db, client.asClient(), fastQueue());
    await upsertCampaign(db, campaign(), true);
    await engine.handleMessage({ kind: "message", igsid: "user9", text: "hello", timestamp: T + 10 });
    expect(client.calls.text).toHaveLength(0);
  });
});
