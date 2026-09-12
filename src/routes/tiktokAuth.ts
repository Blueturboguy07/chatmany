// TikTok onboarding routes. "Connect TikTok" → TikTok account holder authorization page →
// callback exchanges the code (valid 10 minutes, single use) for a 1-day access token + 1-year
// refresh token via /tt_user/oauth2/token/, reads the profile, stores the row. Plus status,
// disconnect, and the app-level webhook subscription admin.
//
// Prerequisites on TikTok's side (docs, 2026-09-09): a registered developer (company), an
// approved developer app with the "TikTok Accounts" (Business Comment) and "Business Messaging"
// permissions, the app's "TikTok account holder redirect URL" set to TIKTOK_REDIRECT_URI, and a
// TikTok BUSINESS account (personal/creator accounts cannot authorize Business Messaging).

import {
  TikTokClient,
  buildTikTokAuthorizeUrl,
  exchangeTikTokCode,
  getTikTokWebhook,
  subscribeTikTokWebhook,
  TIKTOK_SCOPES,
} from "../api/tiktok";
import type { TikTokWebhookEventType } from "../api/tiktok";
import { clearTikTokAuth, getTikTokAuth, kvGet, kvSet, now, saveTikTokAuth } from "../db";
import type { Env } from "../types";
import { html, json, redirect } from "./http";

const STATE_KEY = "tiktok_oauth_state";

function configured(env: Env): string | null {
  if (!env.TIKTOK_APP_ID || !env.TIKTOK_APP_SECRET) return "TIKTOK_APP_ID / TIKTOK_APP_SECRET not configured (wrangler secret put)";
  if (!env.TIKTOK_REDIRECT_URI) return "TIKTOK_REDIRECT_URI not configured (wrangler.toml [vars])";
  return null;
}

/** GET /auth/tiktok/authorize — start the flow. */
export async function handleTikTokAuthorize(env: Env, url: URL): Promise<Response> {
  const problem = configured(env);
  if (problem) return json({ error: problem }, 500);
  const state = crypto.randomUUID().replace(/-/g, "");
  await kvSet(env.DB, STATE_KEY, state);
  let target = buildTikTokAuthorizeUrl(env.TIKTOK_APP_ID!, env.TIKTOK_REDIRECT_URI!, state, TIKTOK_SCOPES);
  // Docs: an account that already authorized the same scopes is bounced back WITHOUT a code unless
  // disable_auto_auth=1 is appended, so a reconnect must force the consent page.
  if (url.searchParams.get("force") === "1") target += "&disable_auto_auth=1";
  return redirect(target);
}

/** GET /auth/tiktok/callback — exchange the code, store tokens + profile. */
export async function handleTikTokCallback(env: Env, url: URL): Promise<Response> {
  const problem = configured(env);
  if (problem) return html(`<h1>TikTok not configured</h1><p>${escapeHtml(problem)}</p>`, 500);

  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description") ?? "";
    return html(`<h1>Connection cancelled</h1><p>${escapeHtml(error)} ${escapeHtml(desc)}</p>`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) {
    // TikTok redirects WITHOUT a code when the account already authorized the same scopes.
    return html(
      `<h1>No authorization code</h1>
       <p>TikTok skipped the consent page because this account already authorized the app. Reconnect with a forced consent:</p>
       <p><a href="/auth/tiktok/authorize?force=1">Connect TikTok again</a></p>`,
      400,
    );
  }
  const expected = await kvGet(env.DB, STATE_KEY);
  if (!expected || state !== expected) return html("<h1>Invalid state (possible CSRF)</h1>", 400);

  try {
    const tok = await exchangeTikTokCode(env.TIKTOK_APP_ID!, env.TIKTOK_APP_SECRET!, env.TIKTOK_REDIRECT_URI!, code);
    console.log(`[chatmany:tiktok] OAuth granted scopes: ${tok.scope ?? "none reported"}`);
    const ts = now();

    let profile: { username?: string; display_name?: string; profile_image?: string } = {};
    try {
      profile = await new TikTokClient(tok.access_token, tok.open_id).getProfile();
    } catch (e) {
      console.warn(`[chatmany:tiktok] profile read failed after connect: ${e instanceof Error ? e.message : e}`);
    }

    await saveTikTokAuth(env.DB, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      business_id: tok.open_id,
      expires_at: ts + tok.expires_in,
      refresh_expires_at: ts + tok.refresh_token_expires_in,
      scope: tok.scope ?? null,
      username: profile.username ?? null,
      display_name: profile.display_name ?? null,
      profile_image: profile.profile_image ?? null,
    });

    const missing = TIKTOK_SCOPES.filter((s) => !(tok.scope ?? "").split(",").map((x) => x.trim()).includes(s));
    return html(
      `<h1>TikTok connected ✅</h1>
       <p>@${escapeHtml(profile.username ?? tok.open_id)} is now connected to chatmany.</p>
       ${missing.length ? `<p><b>Heads up:</b> these scopes were not granted: ${escapeHtml(missing.join(", "))}. Comment replies need comment.list.manage; DMs need message.list.send.</p>` : ""}
       <p>The access token is refreshed automatically (valid 1 day; the refresh token lasts 1 year). You can close this tab.</p>`,
    );
  } catch (e) {
    return html(`<h1>Connection failed</h1><pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`, 500);
  }
}

/** Connection status (owner-only; also served at /api/tiktok/status). */
export async function tikTokStatus(env: Env): Promise<Record<string, unknown>> {
  const auth = await getTikTokAuth(env.DB);
  const ts = now();
  if (!auth) return { connected: false, configured: !configured(env) };
  return {
    connected: true,
    configured: !configured(env),
    username: auth.username,
    display_name: auth.display_name,
    profile_image: auth.profile_image,
    business_id: auth.business_id,
    scope: auth.scope,
    expires_at: auth.expires_at,
    refresh_expires_at: auth.refresh_expires_at,
    expires_in_days: Math.max(0, Math.round((auth.refresh_expires_at - ts) / 86400)),
    token_expired: auth.refresh_expires_at <= ts,
  };
}

export async function handleTikTokStatus(env: Env): Promise<Response> {
  return json(await tikTokStatus(env));
}

/** POST /auth/tiktok/disconnect — forget the tokens. */
export async function handleTikTokDisconnect(env: Env): Promise<Response> {
  await clearTikTokAuth(env.DB);
  return json({ disconnected: true });
}

/**
 * GET/POST /admin/tiktok/webhooks — app-level subscriptions. POST subscribes COMMENT and
 * DIRECT_MESSAGE to this Worker's /webhook/tiktok (body may override `callback_url`, and may pass
 * `item_list` to scope COMMENT to specific video ids); GET reads back what TikTok stored.
 */
export async function handleTikTokWebhookAdmin(env: Env, req: Request, url: URL): Promise<Response> {
  const problem = configured(env);
  if (problem) return json({ error: problem }, 500);
  const types: TikTokWebhookEventType[] = ["COMMENT", "DIRECT_MESSAGE"];

  if (req.method.toUpperCase() === "POST") {
    let body: { callback_url?: string; item_list?: string[] } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // empty body is fine
    }
    const callbackUrl = body.callback_url || `${url.origin}/webhook/tiktok`;
    const results: Record<string, unknown> = {};
    for (const t of types) {
      try {
        results[t] = await subscribeTikTokWebhook(env.TIKTOK_APP_ID!, env.TIKTOK_APP_SECRET!, t, callbackUrl, t === "COMMENT" ? body.item_list : undefined);
      } catch (e) {
        results[t] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return json({ callback_url: callbackUrl, results });
  }

  const results: Record<string, unknown> = {};
  for (const t of types) {
    try {
      results[t] = await getTikTokWebhook(env.TIKTOK_APP_ID!, env.TIKTOK_APP_SECRET!, t);
    } catch (e) {
      results[t] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return json({ results });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
