// TikTok token refresh. The access token lives ~1 day and the refresh token ~1 year (docs:
// /tt_user/oauth2/token/ TokenData). The minute cron calls this and rolls the access token once it
// is within REFRESH_WHEN_WITHIN of expiry; buildTikTokRuntime forces a refresh if it finds the
// token already lapsed. TikTok may rotate the refresh token on each refresh, so the returned one
// is always stored.

import { refreshTikTokToken } from "../api/tiktok";
import { getTikTokAuth, now, saveTikTokAuth } from "../db";
import type { Env } from "../types";

const REFRESH_WHEN_WITHIN = 2 * 3600;

export interface TikTokRefreshResult {
  status: "refreshed" | "skipped" | "no_app" | "no_auth" | "expired" | "error";
  detail?: string;
  expiresAt?: number;
}

export async function refreshTikTokTokenIfDue(env: Env, opts: { force?: boolean } = {}): Promise<TikTokRefreshResult> {
  if (!env.TIKTOK_APP_ID || !env.TIKTOK_APP_SECRET) return { status: "no_app" };
  const auth = await getTikTokAuth(env.DB);
  if (!auth) return { status: "no_auth" };

  const ts = now();
  if (auth.refresh_expires_at <= ts) {
    console.warn(
      `[chatmany:tiktok] refresh token EXPIRED at ${new Date(auth.refresh_expires_at * 1000).toISOString()}; owner must reconnect TikTok.`,
    );
    return { status: "expired" };
  }
  if (!opts.force && auth.expires_at - ts > REFRESH_WHEN_WITHIN) return { status: "skipped", expiresAt: auth.expires_at };

  try {
    const d = await refreshTikTokToken(env.TIKTOK_APP_ID, env.TIKTOK_APP_SECRET, auth.refresh_token);
    const expiresAt = ts + d.expires_in;
    await saveTikTokAuth(env.DB, {
      access_token: d.access_token,
      refresh_token: d.refresh_token || auth.refresh_token,
      business_id: d.open_id || auth.business_id,
      expires_at: expiresAt,
      refresh_expires_at: d.refresh_token_expires_in ? ts + d.refresh_token_expires_in : auth.refresh_expires_at,
      scope: d.scope ?? null,
    });
    console.log(`[chatmany:tiktok] token refreshed; new expiry ${new Date(expiresAt * 1000).toISOString()}`);
    return { status: "refreshed", expiresAt };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[chatmany:tiktok] token refresh FAILED (${detail}); expiry ${new Date(auth.expires_at * 1000).toISOString()}`);
    return { status: "error", detail, expiresAt: auth.expires_at };
  }
}
