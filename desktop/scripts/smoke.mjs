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
// From outside the app it checks the fake publik's request log: no chatmany
// call and no usage event before the claim; app_opened (app "chatmany", with
// the key) after it; and no key in any file the app wrote. Screenshots and
// results land in <output folder>/<run>/. A summary goes to
// $GITHUB_STEP_SUMMARY when it is set. Exit 0 only when every check passed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

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
const RUN_TIMEOUT_MS = 180_000;

const results = [];
const check = (run, name, ok, detail) => {
  results.push({ run, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${run}] ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

function fakePublik() {
  const log = [];
  const state = { claimed: false, claimedAt: Infinity, origin: "" };
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
        if (req.method === "GET" && url.pathname === "/api/v1/chatmany/status") return json(200, { connected: false });
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
  check(run, "the app provisioned its install as chatmany 0.1.0", install?.install?.app_slug === "chatmany" && install?.install?.app_version === "0.1.0" && install?.install?.token_ok, install?.install);
  const early = log.filter((e) => e.at < state.claimedAt && (e.path.startsWith("/api/v1/chatmany/") || e.path === "/api/v1/telemetry"));
  check(run, "no chatmany call and no usage event before sign-in", early.length === 0, early.length ? early.map((e) => `${e.method} ${e.path}`) : undefined);
  check(run, "the fake claim page was opened (by the smoke test, as the person)", Number.isFinite(state.claimedAt));
  const opened = log.find((e) => e.path === "/api/v1/telemetry" && e.event?.event === "app_opened");
  check(run, "app_opened was sent after sign-in, for app chatmany, with the key", opened && opened.at >= state.claimedAt && opened.event.app === "chatmany" && opened.bearer, opened?.event);
  const status = log.find((e) => e.path === "/api/v1/chatmany/status" && e.at >= state.claimedAt);
  check(run, "after sign-in the app asked publik for the chatmany status with the key", status?.bearer === true);
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
  `### chatmany smoke test (${process.platform})`,
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
