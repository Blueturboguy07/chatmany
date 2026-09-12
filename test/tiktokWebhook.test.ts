import { describe, expect, it } from "vitest";
import { hmacHex, normalizeTikTokEvent, parseContent, verifyTikTokSignature } from "../src/routes/tiktokWebhook";

const SECRET = "app_secret_123";

describe("signature verification", () => {
  it("accepts a correctly signed, fresh delivery and rejects tampering, staleness and bad headers", async () => {
    const raw = JSON.stringify({ client_key: "app", event: "im_receive_msg", content: "{}" });
    const t = 1_757_400_000;
    const s = await hmacHex(SECRET, `${t}.${raw}`);
    expect(await verifyTikTokSignature(SECRET, raw, `t=${t},s=${s}`, t + 10)).toBe(true);
    expect(await verifyTikTokSignature(SECRET, raw, `t=${t},s=${s.toUpperCase()}`, t + 10)).toBe(true);
    expect(await verifyTikTokSignature(SECRET, raw + " ", `t=${t},s=${s}`, t + 10)).toBe(false);
    expect(await verifyTikTokSignature("other", raw, `t=${t},s=${s}`, t + 10)).toBe(false);
    expect(await verifyTikTokSignature(SECRET, raw, `t=${t},s=${s}`, t + 301)).toBe(false);
    expect(await verifyTikTokSignature(SECRET, raw, `t=${t + 1},s=${s}`, t + 10)).toBe(false);
    expect(await verifyTikTokSignature(SECRET, raw, null, t)).toBe(false);
    expect(await verifyTikTokSignature(SECRET, raw, "garbage", t)).toBe(false);
    expect(await verifyTikTokSignature("", raw, `t=${t},s=${s}`, t)).toBe(false);
  });
});

describe("content parsing", () => {
  it("keeps comment/video ids exact even when TikTok serializes them as huge bare integers", () => {
    const c = parseContent('{"comment_id":7247303576418566913,"video_id":7203946942097902849,"parent_comment_id":7235861947622916866,"timestamp":1687394416109,"text":"SURF"}');
    expect(c.comment_id).toBe("7247303576418566913");
    expect(c.video_id).toBe("7203946942097902849");
    expect(c.parent_comment_id).toBe("7235861947622916866");
    expect(c.timestamp).toBe(1687394416109);
  });
  it("tolerates empty or invalid content", () => {
    expect(parseContent(undefined)).toEqual({});
    expect(parseContent("not json")).toEqual({});
  });
});

describe("event normalization", () => {
  it("turns a new top-level comment into a NormalizedComment", () => {
    const n = normalizeTikTokEvent({
      client_key: "app",
      event: "comment.update",
      create_time: 1_757_400_000,
      user_openid: "biz",
      content: '{"comment_id":7247303576418566913,"video_id":7203946942097902849,"comment_type":"comment","comment_action":"insert","unique_identifier":"+ABc/1==","timestamp":1757400000123,"text":"SURF pls"}',
    });
    expect(n).toEqual({
      kind: "comment",
      event: {
        kind: "comment",
        comment_id: "7247303576418566913",
        igsid: "+ABc/1==",
        text: "SURF pls",
        media_id: "7203946942097902849",
        timestamp: 1757400000,
      },
    });
  });

  it("ignores replies, deletions and visibility changes", () => {
    const base = { event: "comment.update", create_time: 1 };
    expect(normalizeTikTokEvent({ ...base, content: '{"comment_id":1,"video_id":2,"comment_type":"reply","comment_action":"insert"}' }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ ...base, content: '{"comment_id":1,"video_id":2,"comment_type":"comment","comment_action":"delete"}' }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ ...base, content: '{"comment_id":1,"video_id":2,"comment_type":"comment","comment_action":"set_to_hidden"}' }).kind).toBe("ignored");
  });

  it("turns an inbound personal-account DM (incl. a Q&A button tap) into a NormalizedMessage", () => {
    const n = normalizeTikTokEvent({
      client_key: "app",
      event: "im_receive_msg",
      create_time: 1_757_400_000,
      user_openid: "biz",
      content: JSON.stringify({
        from: "alice",
        to: "biz",
        unique_identifier: "+ABc/1==",
        from_user: { id: "+ABc/1==", role: "personal_account" },
        to_user: { id: "biz", role: "business_account" },
        conversation_id: "a1Abc+B==",
        message_id: "m1",
        timestamp: 1757400000123,
        type: "text",
        text: { body: "✅ I followed" },
        reply_source_payload: { reply_source_msg_id: "q1", reply_source_unique_id: "FOLLOW_CONFIRM" },
        is_follower: true,
      }),
    });
    expect(n).toEqual({
      kind: "message",
      event: {
        kind: "message",
        igsid: "+ABc/1==",
        text: "✅ I followed",
        payload: "FOLLOW_CONFIRM",
        timestamp: 1757400000,
        conversation_id: "a1Abc+B==",
        is_follower: true,
        username: "alice",
        message_id: "m1",
      },
    });
  });

  it("ignores our own outbound echo, business senders, EU-stripped events and unknown events", () => {
    expect(normalizeTikTokEvent({ event: "im_send_msg", content: "{}" }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ event: "im_receive_msg", content: '{"from_user":{"id":"biz","role":"business_account"},"conversation_id":"c"}' }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ event: "im_receive_msg_eu", content: '{"to":"biz"}' }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ event: "im_mark_read_msg", content: "{}" }).kind).toBe("ignored");
    expect(normalizeTikTokEvent({ event: "im_receive_msg", content: '{"from_user":{"id":"u","role":"personal_account"}}' }).kind).toBe("ignored"); // no conversation
  });

  it("an image DM still advances the funnel (no text, but a conversation to reply into)", () => {
    const n = normalizeTikTokEvent({
      event: "im_receive_msg",
      content: '{"from_user":{"id":"u","role":"personal_account"},"conversation_id":"c","type":"image","image":{"media_id":"x"},"timestamp":1757400000123}',
    });
    expect(n.kind).toBe("message");
    if (n.kind === "message") expect(n.event.text).toBeUndefined();
  });
});
