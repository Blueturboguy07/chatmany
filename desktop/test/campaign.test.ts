import { describe, expect, it } from "vitest";
import { campaignFromDraft, deliveryText, draftFromCampaign, draftProblem, newDraft, type Draft } from "../src/shared/campaign";
import { contactStateWords, plainError } from "../src/shared/messages";
import type { CampaignRow } from "../src/shared/types";

// The same cases as publik's tests/chatmany-hosted-page.test.tsx: the app and the web page build the same campaign.
describe("the builder's campaign", () => {
  const filled = (over: Partial<Draft> = {}): Draft => ({ ...newDraft(), media_id: "1790000", keywords: "Link, guide, link", link: "https://ada.example/guide", ...over });

  it("defaults to direct delivery: one private reply that carries the link", () => {
    const c = campaignFromDraft(filled(), "ab12cd34");
    expect(c.deliver_in_opening).toBe(true);
    expect([c.check_follow, c.ask_email]).toEqual([false, false]);
    expect(c.keywords).toEqual(["Link", "guide"]);
    expect(c.reward).toEqual({ type: "link", value: "https://ada.example/guide" });
    expect(c.copy.delivery).toBe("Here’s the link you asked for:\n\n{reward}");
    expect(c.campaign_id).toBe("comment-link-ab12cd34");
  });

  it("never sends direct delivery with a follow or email ask", () => {
    const c = campaignFromDraft(filled({ direct: true, check_follow: true, ask_email: true }), "x");
    expect([c.deliver_in_opening, c.check_follow, c.ask_email]).toEqual([true, false, false]);
  });

  it("puts the link where {link} says, and the preview shows the same text", () => {
    const d = filled({ dm_text: "Grab it here {link} before Friday" });
    expect(campaignFromDraft(d, "x").copy.delivery).toBe("Grab it here {reward} before Friday");
    expect(deliveryText(d)).toBe("Grab it here https://ada.example/guide before Friday");
  });

  it("reads a saved campaign back without losing what the form does not show", () => {
    const saved: CampaignRow = { ...campaignFromDraft(filled({ name: "Guide drop" }), "x"), refusal_fallback: { enabled: true, text: "dm me" }, active: false, archived: false, updated_at: 1 };
    const again = campaignFromDraft(draftFromCampaign(saved), "other");
    expect(again.campaign_id).toBe(saved.campaign_id);
    expect(again.refusal_fallback).toEqual({ enabled: true, text: "dm me" });
    expect(again).not.toHaveProperty("active");
  });

  it("says what is missing in the builder's words", () => {
    expect(draftProblem(newDraft())?.message).toBe("Pick the post this automation watches.");
    expect(draftProblem(filled({ link: "javascript:alert(1)" }))?.field).toBe("link");
    expect(draftProblem(filled())).toBeNull();
  });
});

describe("messages", () => {
  it("are plain words for every failure", () => {
    expect(plainError(0)).toContain("Couldn’t reach publik");
    expect(plainError(503, "chatmany_hosted_unavailable")).toBe("chatmany is not available yet. Try again later.");
    expect(plainError(400, "campaigns[0].deliver_in_opening cannot be combined with check_follow")).toContain("cannot be combined");
    expect(plainError(403, "wrong_app")).toContain("Download chatmany again");
    expect(plainError(429, "rate_limit_exceeded")).toContain("Wait a minute");
    expect(contactStateWords({ state: "DONE", status_label: "delivered" })).toBe("Got the link");
  });
});
