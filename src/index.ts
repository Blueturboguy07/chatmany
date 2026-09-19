// chatmany Worker entry point. `fetch` serves the OAuth onboarding + owner API routes;
// `scheduled` runs the polling crons and the daily token refresh. The UI (Section 7A) will be
// added later and served from this same Worker.

import type { Env } from "./types";
import { isHosted } from "./types";
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
import { fanOutTick, handleHosted } from "./routes/hosted";

export { TenantDO } from "./tenant/do";

const POLL_CRON = "* * * * *";
const REFRESH_CRON = "0 3 * * *";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // --- public routes ---
    if (pathname === "/health") {
      return json({ ok: true, mode: env.MODE, hosted: isHosted(env) });
    }

    // --- hosted (multi-tenant) routes: /webhook/{tenant} and the /hosted/* control plane ---
    // Returns null on a self-host deployment, so nothing below changes for a self-hoster.
    const hostedRes = await handleHosted(env, req, url, ctx);
    if (hostedRes) return hostedRes;

    // OAuth onboarding.
    if (pathname === "/auth/authorize" && method === "GET") return handleAuthorize(env);
    if (pathname === "/auth/callback" && method === "GET") return handleCallback(env, url);

    // Webhook (only meaningful when MODE=webhook; verification is always safe to answer).
    if (pathname === "/webhook" && method === "GET") return handleWebhookVerify(env, url);
    if (pathname === "/webhook" && method === "POST") return handleWebhookEvent(env, req);

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
      // Hosted tenants each refresh their own token on their own alarm (src/tenant/do.ts).
      if (isHosted(env)) return;
      const result = await refreshTokenIfDue(env);
      console.log(`[chatmany] token refresh: ${result.status}`);
      return;
    }
    if (event.cron === POLL_CRON) {
      // Hosted: the cron does NO work inline. It reads the polling tenants and pokes each
      // tenant's Durable Object to re-arm its own alarm — the 2026-08-23 exceededCpu kill was
      // an account-wide tick doing every tenant's work in one invocation.
      if (isHosted(env)) {
        await fanOutTick(env);
        return;
      }
      // In webhook mode, push replaces polling; skip the comment/message polls.
      if (env.MODE === "webhook") return;
      await runPoll(env);
    }
  },
} satisfies ExportedHandler<Env>;

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
