/**
 * Every message the app shows about something that went wrong, in one place.
 * The wording follows the chatmany page on publik (lib/chatmany-hosted/
 * messages.ts there), changed only where the app does a step differently:
 * the app opens Instagram in the browser and waits, so there is no
 * "signed out while connecting" case.
 */

/** How one Instagram connect ended, as GET /api/v1/chatmany/status?connect_id= reports it. */
export const CONNECT_ERRORS = ["cancelled", "awaiting_approval", "personal_account", "account_connected_elsewhere", "expired", "failed"] as const;

export type ConnectError = (typeof CONNECT_ERRORS)[number];

export function isConnectError(value: unknown): value is ConnectError {
  return typeof value === "string" && (CONNECT_ERRORS as readonly string[]).includes(value);
}

export const CONNECT_ERROR_TEXT: Record<ConnectError, string> = {
  cancelled: "You cancelled on Instagram. Nothing was connected.",
  awaiting_approval: "publik is waiting for Instagram approval, so this account cannot connect yet.",
  personal_account:
    "This is a personal Instagram account. Switch it to a Professional account (Creator or Business) in the Instagram app, then connect again.",
  account_connected_elsewhere:
    "This Instagram account is already connected to a different publik account. Disconnect it there first, then connect it here.",
  expired: "That connect link expired or was already used. Press Connect Instagram again.",
  failed: "Instagram did not finish connecting this account. Try again in a moment.",
};

export const CONNECTED_TEXT = "Instagram is connected.";
export const CONNECT_TIMEOUT_TEXT = "Instagram did not answer in 10 minutes. Press Connect Instagram to try again.";

/** Network words. The main process decides which one applies. */
export const OFFLINE_TEXT = "You are offline. Connect to the internet, then try again.";
export const UNREACHABLE_TEXT = "publik is not reachable. Check your connection.";

/** The two error codes publik's chatmany routes answer with. */
export const UNAVAILABLE = "chatmany_hosted_unavailable";
export const UPSTREAM = "chatmany_hosted_error";

/**
 * A request that did not work, in plain words. `error` is the code (or the
 * service's own error text); `status` is the HTTP status (0 = no answer).
 */
export function plainError(status: number, error?: unknown): string {
  const code = typeof error === "string" ? error : "";
  if (status === 0) return "Couldn’t reach publik. Check your connection and try again.";
  if (code === UNAVAILABLE) return "chatmany is not available yet. Try again later.";
  if (code === "invalid_api_key" || code === "key_revoked" || code === "not_signed_in" || status === 401) return "Your publik sign-in ended. Sign in again.";
  if (code === "wrong_app") return "This copy of chatmany cannot use publik. Download chatmany again from publik.";
  if (status === 429 || code === "rate_limited" || code === "rate_limit_exceeded") return "Too many requests. Wait a minute, then try again.";
  if (code === "not_connected" || code === "not connected") return "Instagram is not connected. Connect it first.";
  if (code === "body_too_large") return "That automation is too long to save. Shorten the messages.";
  if (status === 400 && code) return campaignErrorWords(code);
  if (status === 404 || status === 405) return "publik cannot do that here.";
  return "Something went wrong on publik’s side. Try again in a moment.";
}

/** chatmany's validation messages (src/config.ts), translated. */
function campaignErrorWords(code: string): string {
  if (/media_id/.test(code)) return "Pick the post this automation watches.";
  if (/keywords/.test(code)) return "Add at least one keyword.";
  if (/exclude/.test(code)) return "Check the words to skip: separate them with commas.";
  if (/reward/.test(code)) return "Add the link to send.";
  if (/copy\.(opening|delivery)/.test(code)) return "Write the DM they get.";
  if (/public_reply/.test(code)) return "Write the public reply, or turn it off.";
  if (/deliver_in_opening/.test(code)) {
    return "Sending the link straight away cannot be combined with asking them to follow or for their email.";
  }
  if (/campaign_id/.test(code)) return "That automation is missing its id. Close it and try again.";
  if (/invalid JSON|invalid_json/i.test(code)) return "That request was not readable. Try again.";
  return "That did not save. Check the automation and try again.";
}

/** chatmany's funnel states, as the creator would say them. */
const STATE_WORDS: Record<string, string> = {
  NEW: "Starting",
  AWAITING_TAP: "Got the first DM",
  AWAITING_FOLLOW: "Asked to follow",
  AWAITING_EMAIL: "Asked for email",
  DELIVER: "Sending the link",
  DONE: "Got the link",
};

export function contactStateWords(c: { state: string; status_label?: string | null }): string {
  return STATE_WORDS[c.state] ?? c.status_label ?? c.state;
}

/** "MEDIA_CREATOR" and "BUSINESS" as the person knows them. */
export function accountTypeLabel(raw: string | null): string {
  if (!raw) return "Professional account";
  if (/creator/i.test(raw)) return "Creator account";
  if (/business/i.test(raw)) return "Business account";
  return "Professional account";
}
