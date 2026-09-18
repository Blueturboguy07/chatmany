// Pure matching helpers. Whole-word, case-insensitive keyword matching (Section 6, Step 0):
// keyword "ai" fires on "I like this ai" / "AI rocks!" / "love ai!" but NOT "fair" / "rain".

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `keyword` appears as a standalone word in `text` (case-insensitive). Uses a
 * Unicode-aware boundary — NOT String.includes(), which would wrongly fire "ai" inside "fair",
 * and NOT a plain `\b`, which is ASCII-only ([A-Za-z0-9_]) and silently fails to bound any
 * keyword or comment containing an accented letter (e.g. "café", "mañana") even when the case
 * matches exactly. Lookaround on \p{L}/\p{N} keeps the boundary correct for any script while
 * still treating emoji/punctuation as boundaries.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(kw)}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

/** True if any keyword matches (whole-word). */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => matchesKeyword(text, k));
}

/** True if any excluded word is present (same whole-word rule); any match cancels the trigger. */
export function hasExcludedWord(text: string, exclude: string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false;
  return exclude.some((w) => matchesKeyword(text, w));
}

/** A comment triggers a campaign when a keyword matches (or comment_anything is true) AND no excluded word is present. */
export function commentTriggers(text: string, keywords: string[], exclude?: string[], comment_anything?: boolean): boolean {
  return (!!comment_anything || matchesAnyKeyword(text, keywords)) && !hasExcludedWord(text, exclude);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Extract a valid email from free text (chip fallback: user types their address). */
export function extractEmail(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (EMAIL_RE.test(trimmed)) return trimmed;
  // Also catch an email embedded in a longer reply.
  const m = trimmed.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return m ? m[0] : null;
}
