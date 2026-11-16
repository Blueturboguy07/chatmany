// Copied from publik lib/chatmany-hosted/campaign.ts (the web page's code). Keep the two in step.
import type { Campaign, CampaignRow } from "./types";

/**
 * The automation builder's form, and the one way it becomes a chatmany
 * `Campaign`. The service validates every save (chatmany src/config.ts
 * `validateCampaign`); the checks here are the same rules in the builder's
 * words, so a creator sees "Pick the post" under the form instead of
 * "campaigns[0].media_id is required" after a round trip.
 *
 * The DM text says `{link}` where the link goes. chatmany's own placeholder
 * is `{reward}`; the two are swapped on the way in and out. A DM text with
 * no `{link}` gets the link on its own line at the end, so a saved
 * automation always carries the link it was built to send.
 */

export const LINK_TOKEN = "{link}";
const REWARD_TOKEN = "{reward}";

export interface Draft {
  /** "" until the first save. */
  campaign_id: string;
  name: string;
  media_id: string;
  /** As typed: comma separated. */
  keywords: string;
  exclude: string;
  /** The DM, with {link} where the link goes. */
  dm_text: string;
  link: string;
  public_reply_enabled: boolean;
  /** One reply per line; chatmany rotates them. */
  public_reply_text: string;
  /** deliver_in_opening: one private reply that carries the link. */
  direct: boolean;
  opening: string;
  opening_button: string;
  check_follow: boolean;
  follow_gate: string;
  follow_button: string;
  ask_email: boolean;
  email_ask: string;
  active: boolean;
  /** The saved campaign this draft edits, so fields the form does not show survive a save. */
  original: Campaign | null;
}

const DEFAULT_OPENING = "Hey! Tap below and I’ll send you the link.";
const DEFAULT_OPENING_BUTTON = "Send me the link";
const DEFAULT_FOLLOW_GATE = "Follow me first so you don’t miss the next one.";
const DEFAULT_FOLLOW_BUTTON = "I followed";
const DEFAULT_EMAIL_ASK = "Want it by email too? Reply with your email.";

export function newDraft(): Draft {
  return {
    campaign_id: "",
    name: "",
    media_id: "",
    keywords: "",
    exclude: "",
    dm_text: "Here’s the link you asked for:",
    link: "",
    public_reply_enabled: false,
    public_reply_text: "Sent you a DM!\nCheck your DMs.",
    direct: true,
    opening: DEFAULT_OPENING,
    opening_button: DEFAULT_OPENING_BUTTON,
    check_follow: false,
    follow_gate: DEFAULT_FOLLOW_GATE,
    follow_button: DEFAULT_FOLLOW_BUTTON,
    ask_email: false,
    email_ask: DEFAULT_EMAIL_ASK,
    active: true,
    original: null,
  };
}

/** The campaign without the list's switches, which are not part of a saved campaign. */
function campaignOnly(c: CampaignRow | Campaign): Campaign {
  const copy: Record<string, unknown> = { ...c };
  delete copy.active;
  delete copy.archived;
  delete copy.updated_at;
  return copy as unknown as Campaign;
}

export function draftFromCampaign(c: CampaignRow | Campaign): Draft {
  const base = newDraft();
  const active = "active" in c ? Boolean(c.active) : true;
  // A link saved straight after {reward} on its own line reads back as the text alone.
  const delivery = (c.copy?.delivery ?? "").replaceAll(REWARD_TOKEN, LINK_TOKEN);
  const trailing = `\n\n${LINK_TOKEN}`;
  return {
    ...base,
    campaign_id: c.campaign_id,
    name: c.name ?? "",
    media_id: c.media_id,
    keywords: (c.keywords ?? []).join(", "),
    exclude: (c.exclude ?? []).join(", "),
    dm_text: delivery.endsWith(trailing) ? delivery.slice(0, -trailing.length) : delivery,
    link: c.reward?.value ?? "",
    public_reply_enabled: Boolean(c.public_reply?.enabled),
    public_reply_text: (c.public_reply?.texts ?? []).join("\n") || base.public_reply_text,
    direct: Boolean(c.deliver_in_opening),
    opening: c.copy?.opening || base.opening,
    opening_button: c.copy?.opening_button || base.opening_button,
    check_follow: Boolean(c.check_follow),
    follow_gate: c.copy?.follow_gate || base.follow_gate,
    follow_button: c.copy?.follow_button || base.follow_button,
    ask_email: Boolean(c.ask_email),
    email_ask: c.copy?.email_ask || base.email_ask,
    active,
    original: campaignOnly(c),
  };
}

/** Comma-separated words, trimmed, empty ones dropped, the same word once. */
export function splitWords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const word = part.trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
  }
  return out;
}

export function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isSendableLink(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname.includes("."));
  } catch {
    return false;
  }
}

/** The DM exactly as a commenter reads it, with the link in place. */
export function deliveryText(draft: Pick<Draft, "dm_text" | "link">): string {
  const link = draft.link.trim() || "your link";
  const text = draft.dm_text.trim();
  if (text.includes(LINK_TOKEN)) return text.replaceAll(LINK_TOKEN, link);
  return text ? `${text}\n\n${link}` : link;
}

export type DraftProblem = { field: "media" | "keywords" | "dm_text" | "link" | "public_reply" | "opening"; message: string };

/** The first thing stopping a save, in the builder's words, or null. */
export function draftProblem(draft: Draft): DraftProblem | null {
  if (!draft.media_id) return { field: "media", message: "Pick the post this automation watches." };
  if (splitWords(draft.keywords).length === 0) return { field: "keywords", message: "Add at least one keyword." };
  if (!draft.dm_text.trim()) return { field: "dm_text", message: "Write the DM they get." };
  if (!isSendableLink(draft.link)) return { field: "link", message: "Add the link to send. It starts with https://." };
  if (draft.public_reply_enabled && splitLines(draft.public_reply_text).length === 0) {
    return { field: "public_reply", message: "Write the public reply, or turn it off." };
  }
  if (!draft.direct && !draft.opening.trim()) return { field: "opening", message: "Write the first message." };
  return null;
}

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "automation"
  );
}

/**
 * The campaign to save. `idSuffix` names a new one (the caller passes a
 * random string; tests pass a fixed one). Direct delivery and the two gates
 * are never sent together: chatmany refuses that pair, because both gates
 * need a tap that direct delivery removes.
 */
export function campaignFromDraft(draft: Draft, idSuffix: string): Campaign {
  const keywords = splitWords(draft.keywords);
  const name = draft.name.trim() || `Comment ${keywords[0] ?? "keyword"}`;
  const text = draft.dm_text.trim();
  const delivery = (text.includes(LINK_TOKEN) ? text : `${text}\n\n${LINK_TOKEN}`).replaceAll(LINK_TOKEN, REWARD_TOKEN);
  const original = draft.original;
  const replies = splitLines(draft.public_reply_text);
  return {
    ...(original ?? {}),
    campaign_id: draft.campaign_id || `${slugOf(name)}-${idSuffix}`,
    name,
    media_id: draft.media_id,
    keywords,
    exclude: splitWords(draft.exclude),
    public_reply: { enabled: draft.public_reply_enabled && replies.length > 0, texts: replies },
    deliver_in_opening: draft.direct,
    check_follow: draft.direct ? false : draft.check_follow,
    ask_email: draft.direct ? false : draft.ask_email,
    reward: { type: original?.reward?.type ?? "link", value: draft.link.trim() },
    copy: {
      ...(original?.copy ?? {}),
      // chatmany requires an opening even when direct delivery never sends it.
      opening: draft.opening.trim() || DEFAULT_OPENING,
      opening_button: draft.opening_button.trim() || DEFAULT_OPENING_BUTTON,
      follow_gate: draft.follow_gate.trim() || DEFAULT_FOLLOW_GATE,
      follow_button: draft.follow_button.trim() || DEFAULT_FOLLOW_BUTTON,
      email_ask: draft.email_ask.trim() || DEFAULT_EMAIL_ASK,
      delivery,
    },
  };
}
