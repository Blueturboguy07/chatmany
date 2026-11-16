#!/usr/bin/env node
// The CI smoke test of the BUILT app. No dependencies.
//
//   node scripts/smoke.mjs <the app's executable> <output folder>
//
// It starts a fake publik on 127.0.0.1 and launches the app three times with
// --smoke-test (see src/main/smoke.ts), each time on a clean computer (a new
// data folder and a mock keychain):
//
//   sign_in      fake publik up, fake app token: the first screen must be
//                Sign in with publik, nothing may get past it, and after the
//                fake claim page is opened the app must show Connect Instagram;
//   unreachable  nothing listens on the port: the first screen must say
//                "publik is not reachable" with Retry;
//   no_token     a build with no app token: the first screen must say it
//                cannot sign in, and the app must not call publik at all.
//
// In smoke mode the app uses only the token this script gives it and ignores
// any token built into it (src/main/main.ts, appToken()). So a release build,
// which carries the real token, runs all three the same way, and the real
// token never reaches the fake publik.
//
// From outside the app it checks the fake publik's request log: no chatmany
// call and no usage event before the claim; app_opened (app "chatmany", with
// the key) after it; and no key in any file the app wrote. Screenshots and
// results land in <output folder>/<run>/. A summary goes to
// $GITHUB_STEP_SUMMARY when it is set. Exit 0 only when every check passed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";

const [exe, outArg] = process.argv.slice(2);
if (!exe || !existsSync(exe)) {
  console.error(`usage: node scripts/smoke.mjs <app executable> <output folder> (not found: ${exe ?? "nothing given"})`);
  process.exit(2);
}
const OUT = resolve(outArg ?? "smoke-out");
mkdirSync(OUT, { recursive: true });

const FAKE_TOKEN = `pat_chatmany_${randomBytes(16).toString("hex")}`;
const FAKE_KEY = `pk_test_${randomBytes(16).toString("hex")}`;
const CLAIM_CODE = "ABCD-EFGH";
// The sign_in run tours the whole workspace; under Rosetta (x64 on an arm64 runner) it takes minutes.
const RUN_TIMEOUT_MS = 360_000;
/**
 * The version the app must report: this folder's package.json, or
 * CHATMANY_SMOKE_EXPECT_VERSION when the app is a release built from another
 * commit (desktop-release-smoke.yml sets it from the file name).
 */
const VERSION = process.env.CHATMANY_SMOKE_EXPECT_VERSION || JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** A plain coloured square as a data: picture, so the post grid has previews without any network. */
const swatch = (fill) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="${fill}"/></svg>`).toString("base64")}`;
/** The creator's recent posts, as GET /api/v1/chatmany/api/media answers them. */
const MEDIA = [
  ["IMAGE", "New guide out now. Comment GUIDE for the link.", "#c7d2fe"],
  ["VIDEO", "Behind the scenes of the shoot", "#fde68a"],
  ["CAROUSEL_ALBUM", "Three tips for better light", "#bbf7d0"],
  ["IMAGE", "My desk setup", "#fecaca"],
  ["VIDEO", "Q and A, part two", "#e9d5ff"],
  ["IMAGE", "Studio day", "#bae6fd"],
].map(([media_type, caption, fill], i) => ({
  id: `1790000000000000${i + 1}`,
  caption,
  media_type,
  ...(media_type === "VIDEO" ? { thumbnail_url: swatch(fill) } : { media_url: swatch(fill) }),
  permalink: `https://www.instagram.com/p/smoke${i + 1}/`,
}));

const results = [];
const check = (run, name, ok, detail) => {
  results.push({ run, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${run}] ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

/** A connected Creator account, as GET /api/v1/chatmany/status answers it. */
const CONNECTED = { connected: true, username: "smoke.creator", account_type: "MEDIA_CREATOR", profile_picture_url: null, ig_user_id: "17841400000000000", expires_at: 1_800_000_000, expires_in_days: 55, token_expired: false };
/** publik's billing words for a creator whose balance is empty (publik lib/chatmany-app/billing.ts). Shares only. */
const EMPTY_BALANCE = {
  can_pay: false,
  notice: {
    title: "Replies are paused. Your publik balance is empty.",
    body: "chatmany sends no DMs and no public replies while your balance is empty. Start a plan or add a top-up in your wallet. Replies start again about a minute later.",
  },
  usage: {
    hosting_share: 0.12,
    used_share: 0.4,
    resets_at: "2026-12-01T00:00:00Z",
    prepaid_left_share: null,
    headline: "chatmany used 12% of your plan’s monthly limit.",
    detail: "All your apps used 40%. The limit resets on Dec 1.",
    cost: "Hosting is charged at what it costs publik, plus 10%. While it costs publik nothing, it costs you nothing.",
  },
};

function fakePublik() {
  const log = [];
  const state = { claimed: false, claimedAt: Infinity, origin: "", connects: [], approved: new Set(), connected: false };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const bearer = (req.headers.authorization ?? "") === `Bearer ${FAKE_KEY}`;
      const entry = { at: Date.now(), method: req.method, path: url.pathname, bearer };
      log.push(entry);
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const parsed = () => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      };

      if (req.method === "POST" && url.pathname === "/api/v1/installs") {
        const b = parsed() ?? {};
        // Only "is it the smoke token" is kept: a release build also carries the real token, which must never be sent here.
        entry.install = { app_slug: b.app_slug, app_version: b.app_version, os: b.os, token_ok: b.app_token === FAKE_TOKEN };
        if (b.app_token !== FAKE_TOKEN || b.app_slug !== "chatmany") return json(401, { error: { type: "invalid_app_token", message: "The app token is unknown, wrong, or revoked." } });
        return json(201, { install_id: b.install_id, key: FAKE_KEY, claim_url: `${state.origin}/claim/${CLAIM_CODE}`, claim_code: CLAIM_CODE, claim_state: "anonymous" });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/wallet") {
        if (!bearer) return json(401, { error: { type: "invalid_api_key", message: "unknown key" } });
        return json(200, {
          claim_state: state.claimed ? "claimed" : "anonymous",
          claim_url: state.claimed ? null : `${state.origin}/claim/${CLAIM_CODE}`,
          account: state.claimed ? { handle: "smoke-test" } : null,
          plan: { kind: "none", label: null },
          balance_micros: 0,
        });
      }
      // The person approves on Instagram: the newest connect lands (the smoke test calls this, as the person).
      if (req.method === "GET" && url.pathname === "/fake/instagram-approved") {
        const last = state.connects.at(-1);
        if (last) state.approved.add(last);
        state.connected = Boolean(last);
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      if (req.method === "GET" && url.pathname === `/claim/${CLAIM_CODE}`) {
        state.claimed = true;
        state.claimedAt = Date.now();
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<p>Signed in.</p>");
      }
      if (req.method === "POST" && url.pathname === "/api/v1/telemetry") {
        entry.event = parsed();
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname.startsWith("/api/v1/chatmany/")) {
        if (!bearer) return json(401, { error: { type: "invalid_api_key", message: "unknown key" } });
        if (!state.claimed) return json(403, { error: { type: "not_signed_in", message: "Sign in with publik first." } });
        if (req.method === "GET" && url.pathname === "/api/v1/chatmany/status") {
          const connectId = url.searchParams.get("connect_id");
          if (connectId) {
            entry.connectId = connectId;
            return json(200, state.approved.has(connectId) ? { ...CONNECTED, connect: { state: "connected" } } : { connected: false, connect: { state: "waiting" } });
          }
          return json(200, state.connected ? { ...CONNECTED, billing: EMPTY_BALANCE } : { connected: false, billing: null });
        }
        if (req.method === "POST" && url.pathname === "/api/v1/chatmany/connect-url") {
          const id = `smokeconnect${String(state.connects.length + 1).padStart(10, "0")}`;
          state.connects.push(id);
          return json(200, { url: `https://www.instagram.com/oauth/authorize?client_id=smoke&state=app1.${id}`, connect_id: id, expires_at: Math.floor(Date.now() / 1000) + 600 });
        }
        if (state.connected && req.method === "GET") {
          const path = url.pathname.slice("/api/v1/chatmany/api/".length);
          if (path === "media") return json(200, { media: MEDIA });
          if (path === "campaigns") return json(200, { campaigns: [] });
          if (path === "contacts") return json(200, { contacts: [] });
          if (path === "dashboard") return json(200, { campaign_id: null, days: 30, cards: { comments: 3, sends: 2, clicks: 0, ctr: 0, follows: 0, emails: 0, delivered: 2 }, funnel: [] });
        }
        return json(409, { error: { type: "not_connected", message: "Instagram is not connected." } });
      }
      return json(404, { error: { type: "not_found", message: "not found" } });
    });
  });
  return { server, log, state };
}

function listen(server) {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
}

function launch(run, env) {
  const dir = join(OUT, run);
  mkdirSync(dir, { recursive: true });
  const childEnv = { ...process.env, ...env, ELECTRON_ENABLE_LOGGING: "1" };
  // The app counts usage only on the fake publik here, so counting stays on for the run.
  delete childEnv.DO_NOT_TRACK;
  delete childEnv.PUBLIK_TELEMETRY;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.CHATMANY_SMOKE_EXPECT_VERSION;
  if (!env.CHATMANY_SMOKE_APP_TOKEN) delete childEnv.CHATMANY_SMOKE_APP_TOKEN;
  return new Promise((done) => {
    const child = spawn(exe, [`--smoke-test=${dir}`], { env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, timedOut: true, dir });
    }, RUN_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, timedOut: false, dir });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, timedOut: false, dir, error: error.message });
    });
  });
}

function readResult(run, dir) {
  try {
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    for (const c of result.checks ?? []) check(run, `app: ${c.name}`, c.ok, c.ok ? undefined : c.detail);
    return result;
  } catch {
    check(run, "the app wrote result.json", false);
    return null;
  }
}

function noKeyInFiles(run, dir) {
  const leaks = readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(FAKE_KEY));
  check(run, "no file the app wrote holds the key", leaks.length === 0, leaks.length ? leaks : undefined);
}

// ---------- run 1: sign_in ----------
{
  const run = "sign_in";
  const { server, log, state } = fakePublik();
  const port = await listen(server);
  state.origin = `http://127.0.0.1:${port}`;
  const done = await launch(run, { CHATMANY_SMOKE_ORIGIN: state.origin, CHATMANY_SMOKE_APP_TOKEN: FAKE_TOKEN, CHATMANY_SMOKE_EXPECT: run });
  await new Promise((r) => setTimeout(r, 500));
  server.close();
  check(run, "the app exited 0", done.code === 0, done.timedOut ? "timed out" : (done.error ?? `exit ${done.code}`));
  readResult(run, done.dir);
  noKeyInFiles(run, done.dir);
  const install = log.find((e) => e.path === "/api/v1/installs");
  check(run, `the app provisioned its install as chatmany ${VERSION}`, install?.install?.app_slug === "chatmany" && install?.install?.app_version === VERSION && install?.install?.token_ok, install?.install);
  const installs = log.filter((e) => e.install);
  check(run, "every install request carried the smoke test's token, never a token built into the app", installs.length > 0 && installs.every((e) => e.install.token_ok), installs.length);
  const early = log.filter((e) => e.at < state.claimedAt && (e.path.startsWith("/api/v1/chatmany/") || e.path === "/api/v1/telemetry"));
  check(run, "no chatmany call and no usage event before sign-in", early.length === 0, early.length ? early.map((e) => `${e.method} ${e.path}`) : undefined);
  check(run, "the fake claim page was opened (by the smoke test, as the person)", Number.isFinite(state.claimedAt));
  const opened = log.find((e) => e.path === "/api/v1/telemetry" && e.event?.event === "app_opened");
  check(run, "app_opened was sent after sign-in, for app chatmany, with the key", opened && opened.at >= state.claimedAt && opened.event.app === "chatmany" && opened.bearer, opened?.event);
  const status = log.find((e) => e.path === "/api/v1/chatmany/status" && e.at >= state.claimedAt);
  check(run, "after sign-in the app asked publik for the chatmany status with the key", status?.bearer === true);
  const links = log.filter((e) => e.method === "POST" && e.path === "/api/v1/chatmany/connect-url");
  check(run, "Connect, then I cancelled, start again: two connect links, both with the key", links.length === 2 && links.every((e) => e.bearer), links.length);
  const polled = new Set(log.filter((e) => e.connectId).map((e) => e.connectId));
  check(run, "the app polled the second connect after starting again", polled.has(state.connects[1]), [...polled]);
  const writes = log.filter((e) => e.method === "POST" && (e.path === "/api/v1/chatmany/disconnect" || e.path.startsWith("/api/v1/chatmany/api/")));
  check(run, "looking around changed nothing: no disconnect, no automation saved or deleted", writes.length === 0, writes.map((e) => e.path));
  writeFileSync(join(done.dir, "requests.json"), `${JSON.stringify(log.map(({ at, method, path, bearer, event }) => ({ at, method, path, bearer, event: event?.event })), null, 2)}\n`);
}

// ---------- run 2: unreachable ----------
{
  const run = "unreachable";
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r)); // nothing listens on this port now
  const done = await launch(run, { CHATMANY_SMOKE_ORIGIN: `http://127.0.0.1:${port}`, CHATMANY_SMOKE_APP_TOKEN: FAKE_TOKEN, CHATMANY_SMOKE_EXPECT: run });
  check(run, "the app exited 0", done.code === 0, done.timedOut ? "timed out" : (done.error ?? `exit ${done.code}`));
  readResult(run, done.dir);
}

// ---------- run 3: no_token ----------
{
  const run = "no_token";
  const { server, log, state } = fakePublik();
  const port = await listen(server);
  state.origin = `http://127.0.0.1:${port}`;
  const done = await launch(run, { CHATMANY_SMOKE_ORIGIN: state.origin, CHATMANY_SMOKE_EXPECT: run });
  server.close();
  check(run, "the app exited 0", done.code === 0, done.timedOut ? "timed out" : (done.error ?? `exit ${done.code}`));
  readResult(run, done.dir);
  check(run, "a build with no app token calls publik not once", log.length === 0, log.length ? log.map((e) => `${e.method} ${e.path}`) : undefined);
}

const failed = results.filter((r) => !r.ok);
const lines = [
  `### chatmany smoke test (${basename(OUT)}, ${process.platform})`,
  "",
  failed.length === 0 ? `All ${results.length} checks passed.` : `${failed.length} of ${results.length} checks FAILED.`,
  "",
  "| Run | Check | Result |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.run} | ${r.name.replaceAll("|", "\\|")} | ${r.ok ? "pass" : "**FAIL**"} |`),
  "",
];
writeFileSync(join(OUT, "summary.md"), lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
