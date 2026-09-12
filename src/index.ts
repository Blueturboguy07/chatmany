// chatmany Worker entry point. `fetch` serves the OAuth onboarding + owner API routes;
// `scheduled` runs the polling crons and the daily token refresh. The UI (Section 7A) will be
// added later and served from this same Worker.

import type { Env } from "./types";
import { buildRuntime } from "./runtime";
import { pollComments } from "./poller/commentPoll";
import { pollMessages } from "./poller/messagePoll";
import { refreshTokenIfDue } from "./auth/refresh";
import { claimPollSlot } from "./db";
import { handleAuthorize, handleCallback, handleDisconnect, handleStatus } from "./routes/auth";
import { handleConfigExport, handleConfigImport } from "./routes/config";
import { handleWebhookEvent, handleWebhookVerify } from "./routes/webhook";
import { handleApi } from "./routes/api";
import { isOwner, json } from "./routes/http";
import {
  handleTikTokAuthorize,
  handleTikTokCallback,
  handleTikTokDisconnect,
  handleTikTokStatus,
  handleTikTokWebhookAdmin,
} from "./routes/tiktokAuth";
import { handleTikTokWebhookEvent, handleTikTokWebhookVerify } from "./routes/tiktokWebhook";
import { refreshTikTokTokenIfDue } from "./auth/tiktokRefresh";
import { buildTikTokRuntime } from "./tiktokRuntime";
import { pollTikTokComments, pollTikTokMessages } from "./poller/tiktokPoll";

const POLL_CRON = "* * * * *";
const REFRESH_CRON = "0 3 * * *";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // --- public routes ---
    if (pathname === "/health") return json({ ok: true, mode: env.MODE });

    // OAuth onboarding.
    if (pathname === "/auth/authorize" && method === "GET") return handleAuthorize(env);
    if (pathname === "/auth/callback" && method === "GET") return handleCallback(env, url);

    // Webhook (only meaningful when MODE=webhook; verification is always safe to answer).
    if (pathname === "/webhook" && method === "GET") return handleWebhookVerify(env, url);
    if (pathname === "/webhook" && method === "POST") return handleWebhookEvent(env, req);

    // TikTok: OAuth onboarding + signed webhook deliveries (comments and DMs are pushed here).
    if (pathname === "/auth/tiktok/authorize" && method === "GET") return handleTikTokAuthorize(env, url);
    if (pathname === "/auth/tiktok/callback" && method === "GET") return handleTikTokCallback(env, url);
    if (pathname === "/webhook/tiktok" && method === "GET") return handleTikTokWebhookVerify(url);
    if (pathname === "/webhook/tiktok" && method === "POST") return handleTikTokWebhookEvent(env, req);

    // --- owner-only API + admin routes ---
    if (pathname.startsWith("/api/")) {
      if (!isOwner(req, url, env)) return json({ error: "unauthorized" }, 401);
      return handleApi(env, req, url);
    }
    const ownerRoutes = new Set([
      "/auth/status",
      "/auth/disconnect",
      "/config/import",
      "/config/export",
      "/admin/poll",
      "/auth/tiktok/status",
      "/auth/tiktok/disconnect",
      "/admin/tiktok/webhooks",
      "/admin/tiktok/poll",
    ]);
    if (ownerRoutes.has(pathname)) {
      if (!isOwner(req, url, env)) return json({ error: "unauthorized" }, 401);
      if (pathname === "/auth/status" && method === "GET") return handleStatus(env);
      if (pathname === "/auth/disconnect" && method === "POST") return handleDisconnect(env);
      if (pathname === "/config/import" && method === "POST") return handleConfigImport(env, req);
      if (pathname === "/config/export" && method === "GET") return handleConfigExport(env);
      // Manual poll trigger for testing without waiting for cron.
      if (pathname === "/admin/poll" && method === "POST") {
        await runPoll(env);
        return json({ ok: true, ran: "poll" });
      }
      if (pathname === "/auth/tiktok/status" && method === "GET") return handleTikTokStatus(env);
      if (pathname === "/auth/tiktok/disconnect" && method === "POST") return handleTikTokDisconnect(env);
      if (pathname === "/admin/tiktok/webhooks") return handleTikTokWebhookAdmin(env, req, url);
      // Manual TikTok poll (comments + conversations) — the fallback transport, and a test hook.
      if (pathname === "/admin/tiktok/poll" && method === "POST") {
        const ran = await runTikTokPoll(env);
        return json({ ok: true, ran: ran ? "tiktok-poll" : "skipped (no TikTok account connected)" });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // --- web UI (static assets + SPA fallback) ---
    // Matched static files are served by the assets binding automatically; this handles
    // client-side routes by returning index.html for navigations.
    const assetRes = await env.ASSETS.fetch(req);
    if (assetRes.status !== 404) return assetRes;
    if (method === "GET") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === REFRESH_CRON) {
      const result = await refreshTokenIfDue(env);
      console.log(`[chatmany] token refresh: ${result.status}`);
      return;
    }
    if (event.cron === POLL_CRON) {
      // TikTok's access token lives one day: check every tick, refresh when within 2h of expiry.
      const tt = await refreshTikTokTokenIfDue(env);
      if (tt.status === "refreshed" || tt.status === "error" || tt.status === "expired") {
        console.log(`[chatmany:tiktok] token refresh: ${tt.status}${tt.detail ? ` (${tt.detail})` : ""}`);
      }
      if (env.TIKTOK_MODE === "polling") await runTikTokPoll(env);

      // In webhook mode, push replaces polling; skip the Instagram comment/message polls.
      if (env.MODE === "webhook") return;
      await runPoll(env);
    }
  },
} satisfies ExportedHandler<Env>;

/** TikTok polling fallback: comments on campaign videos + conversations that changed. */
async function runTikTokPoll(env: Env): Promise<boolean> {
  const rt = await buildTikTokRuntime(env);
  if (!rt) return false;
  await pollTikTokComments(rt, env.DB);
  await pollTikTokMessages(rt, env.DB);
  return true;
}

/**
 * Run comment + message polls, honoring the configured poll interval (>= cron granularity).
 * claimPollSlot is an atomic claim, not a plain check-then-act read/write — see its doc comment
 * in db.ts for why that distinction matters: it's what stops an overlapping cron tick or a
 * /admin/poll call racing the cron from both polling at once and double-sending a real DM.
 */
async function runPoll(env: Env): Promise<void> {
  const interval = Math.max(30, Number(env.POLL_INTERVAL_SECONDS) || 90);
  const claimed = await claimPollSlot(env.DB, interval);
  if (!claimed) return; // not due yet, or another invocation already claimed this slot

  const rt = await buildRuntime(env);
  if (!rt) return;

  await pollComments(rt, env.DB);
  await pollMessages(rt, env.DB);
}
