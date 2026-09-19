// How a failed send is classified. This is the single most expensive lesson in chatmany's field
// record, so it lives in one function with the incident attached.
//
// 2026-08-23: `POST /{ig_user_id}/messages` answered HTTP 500, code 1, "An unknown error has
// occurred." for many comments — and Instagram DELIVERED the message anyway. The engine assumed
// "we received an HTTP response, therefore nothing went out", released the claim, left the
// comment unprocessed, and re-sent on every 90-second tick: 116 duplicate DMs to 8 real
// followers, one person got 26. A 5xx (or Meta code 1/2) is an UNKNOWN outcome, exactly like a
// dropped socket, and must never be retried.
//
// 2026-09-15/16: the opposite failure. Private replies to non-followers are refused permanently
// with code 100 / subcode 2534001 ("thread owner has archived or deleted this conversation")
// — ~75% of them on the ghost reel — and retrying each one forever burned the send budget and
// the 1.2s pacing slot while nothing could ever be delivered. Those are dead-lettered.

import { InstagramApiError } from "../api/client";

export type SendFailure =
  /** Outcome unknown: it may already be in the person's inbox. Keep the claim; NEVER retry. */
  | "ambiguous"
  /** Instagram told us to back off (429, codes 4/17/32/613/80007). Nothing sent; retry later. */
  | "rate_limited"
  /** Refused for good (non-follower, deleted thread, unapproved tag). Nothing sent; stop trying. */
  | "permanent"
  /** Ordinary 4xx: nothing sent, retrying is safe and may work. */
  | "refused";

/** Meta subcodes/codes that mean "this recipient will never accept this message". */
const PERMANENT_SUBCODES = new Set([2534001, 2534022]);
const PERMANENT_CODES = new Set([10, 551]);

export function classifySendFailure(e: unknown): SendFailure {
  if (!(e instanceof InstagramApiError)) return "ambiguous"; // fetch threw: no answer at all
  if (e.isRateLimit) return "rate_limited";
  // A 5xx, or Meta's generic code 1/2, can arrive AFTER delivery — treat as unknown, not refused.
  if (e.status >= 500 || e.code === 1 || e.code === 2) return "ambiguous";
  if (e.subcode !== undefined && PERMANENT_SUBCODES.has(e.subcode)) return "permanent";
  if (e.code !== undefined && PERMANENT_CODES.has(e.code)) return "permanent";
  if (/cannot be found|does not exist/i.test(e.message)) return "permanent";
  return "refused";
}

/** A short, safe label for the dead-letter ledger. Carries no handle and no IGSID. */
export function failureTag(e: unknown): string {
  if (!(e instanceof InstagramApiError)) return "network";
  return `${e.status}/${e.code ?? "-"}/${e.subcode ?? "-"}`;
}
