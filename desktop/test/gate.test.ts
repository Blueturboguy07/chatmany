import { describe, expect, it } from "vitest";
import type { GateView } from "../src/shared/bridge";
import { OFFLINE_TEXT, UNREACHABLE_TEXT } from "../src/shared/messages";
import { NO_TOKEN_TEXT, POLL_LIMIT_MS, POLL_MS, PublikGate, SIGN_IN_TIMEOUT, SIGN_IN_WAITING, type InstallStore, type StoredInstall } from "../src/main/publik";

const ORIGIN = "https://publikhq.com";
const TOKEN = `pat_chatmany_${"a1".repeat(16)}`;
const KEY = "pk_live_abc123_secretsecretsecret";
const INSTALL = "3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f";

type Route = (init: RequestInit & { url: string }) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(routes: Record<string, Route>, options: { token?: string | null; stored?: StoredInstall | null; online?: boolean; usageOff?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  let stored: StoredInstall | null = options.stored ?? null;
  const store: InstallStore = { read: () => stored, write: (v) => void (stored = v) };
  const views: GateView[] = [];
  const opened: string[] = [];
  const timers: Array<() => void> = [];
  let now = 1_000_000;
  const fetchFake = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ method, path: url.pathname, auth: headers.get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new TypeError("fetch failed");
    return route({ ...init, url: input });
  }) as unknown as typeof fetch;
  const gate = new PublikGate({
    origin: ORIGIN,
    appToken: options.token === undefined ? TOKEN : options.token,
    fetch: fetchFake,
    store,
    openUrl: (url) => void opened.push(url),
    isOnline: () => options.online ?? true,
    device: { os: "macos", arch: "arm64", name: "Test Mac" },
    telemetry: { installId: () => "0b7c5a52-4f0e-4c55-9a3c-2f4a6b8c9d0e", off: () => options.usageOff ?? false },
    onChange: (v) => void views.push(v),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
    now: () => now,
  });
  /** Runs the next scheduled poll after `ms`. */
  const tick = async (ms = POLL_MS) => {
    now += ms;
    const fn = timers.shift();
    fn?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { gate, calls, views, opened, tick, stored: () => stored, timers };
}

const wallet = (claim: "anonymous" | "claimed") => () =>
  json(200, { claim_state: claim, claim_url: claim === "anonymous" ? `${ORIGIN}/claim/ABCD-EFGH` : null, account: claim === "claimed" ? { handle: "ada" } : null });
const minted = () => json(201, { install_id: INSTALL, key: KEY, claim_url: `${ORIGIN}/claim/ABCD-EFGH`, claim_state: "anonymous" });

describe("the sign-in gate", () => {
  it("provisions an install for chatmany and shows Sign in with publik", async () => {
    const h = harness({ "POST /api/v1/installs": minted, "GET /api/v1/wallet": wallet("anonymous") });
    await h.gate.start();
    expect(h.gate.current()).toEqual({ screen: "sign_in", note: null, waiting: false });
    const mint = h.calls.find((c) => c.path === "/api/v1/installs")!;
    expect(mint.body).toMatchObject({ app_token: TOKEN, app_slug: "chatmany", app_version: "0.1.2", os: "macos", arch: "arm64", disclosure_version: 1 });
    expect(h.stored()?.key).toBe(KEY);
    // No key for anything else while the install is not signed in.
    expect(h.gate.signedInKey()).toBeNull();
    expect(JSON.stringify(h.views)).not.toContain("pk_");
  });

  it("opens the claim page in the browser, waits, and lets the person through once publik says claimed", async () => {
    let claimed = false;
    const h = harness({
      "POST /api/v1/installs": minted,
      "GET /api/v1/wallet": () => wallet(claimed ? "claimed" : "anonymous")(),
      "POST /api/v1/telemetry": () => new Response(null, { status: 204 }),
    });
    await h.gate.start();
    await h.gate.signIn();
    expect(h.opened).toEqual([`${ORIGIN}/claim/ABCD-EFGH`]);
    expect(h.gate.current()).toEqual({ screen: "sign_in", note: SIGN_IN_WAITING, waiting: true });
    await h.tick();
    expect(h.gate.current().screen).toBe("sign_in");
    expect(h.calls.some((c) => c.path === "/api/v1/telemetry")).toBe(false);
    claimed = true;
    await h.tick();
    expect(h.gate.current()).toEqual({ screen: "signed_in", handle: "ada" });
    expect(h.gate.signedInKey()).toBe(KEY);
    const event = h.calls.find((c) => c.path === "/api/v1/telemetry")!;
    expect(event.auth).toBe(`Bearer ${KEY}`);
    expect(event.body).toMatchObject({ v: 1, app: "chatmany", event: "app_opened", app_version: "0.1.2", os: "macos" });
  });

  it("stops asking after 10 minutes and says so", async () => {
    const h = harness({ "POST /api/v1/installs": minted, "GET /api/v1/wallet": wallet("anonymous") });
    await h.gate.start();
    await h.tick(POLL_LIMIT_MS + 1);
    expect(h.gate.current()).toEqual({ screen: "sign_in", note: SIGN_IN_TIMEOUT, waiting: false });
  });

  it("never opens a claim link that is not on publik", async () => {
    const h = harness({
      "POST /api/v1/installs": () => json(201, { install_id: INSTALL, key: KEY, claim_url: "https://evil.example/claim" }),
      "GET /api/v1/wallet": () => json(200, { claim_state: "anonymous", claim_url: "https://evil.example/claim" }),
    });
    await h.gate.start();
    await h.gate.signIn();
    expect(h.opened).toEqual([`${ORIGIN}/wallet`]);
  });

  it("goes straight through with a stored key that publik says is signed in", async () => {
    const h = harness({ "GET /api/v1/wallet": wallet("claimed"), "POST /api/v1/telemetry": () => new Response(null, { status: 204 }) }, { stored: { install_id: INSTALL, key: KEY, claim_url: null } });
    await h.gate.start();
    expect(h.gate.current()).toEqual({ screen: "signed_in", handle: "ada" });
    expect(h.calls.some((c) => c.path === "/api/v1/installs")).toBe(false);
  });

  it("provisions again when publik no longer knows the stored key", async () => {
    let first = true;
    const h = harness(
      {
        "GET /api/v1/wallet": (init) => {
          const auth = new Headers(init.headers).get("authorization");
          if (first && auth === "Bearer pk_live_old_key_000000000") {
            first = false;
            return json(401, { error: { type: "key_revoked", message: "revoked" } });
          }
          return wallet("anonymous")();
        },
        "POST /api/v1/installs": minted,
      },
      { stored: { install_id: INSTALL, key: "pk_live_old_key_000000000", claim_url: null } },
    );
    await h.gate.start();
    expect(h.gate.current().screen).toBe("sign_in");
    expect(h.stored()?.key).toBe(KEY);
  });

  it("asks for a new install id when publik will not hand out an existing install's key", async () => {
    const ids: string[] = [];
    const h = harness({
      "POST /api/v1/installs": (init) => {
        const body = JSON.parse(String(init.body)) as { install_id: string };
        ids.push(body.install_id);
        return ids.length === 1 ? json(200, { install_id: body.install_id, key: null }) : json(201, { install_id: body.install_id, key: KEY, claim_url: null });
      },
      "GET /api/v1/wallet": wallet("anonymous"),
    }, { stored: { install_id: INSTALL, key: null, claim_url: null } });
    await h.gate.start();
    expect(ids[0]).toBe(INSTALL);
    expect(ids[1]).not.toBe(INSTALL);
    expect(h.gate.current().screen).toBe("sign_in");
  });

  it("says publik is not reachable when it does not answer, with the offline words when there is no network", async () => {
    const down = harness({});
    await down.gate.start();
    expect(down.gate.current()).toEqual({ screen: "unreachable", offline: false, message: UNREACHABLE_TEXT });
    const offline = harness({}, { online: false });
    await offline.gate.start();
    expect(offline.gate.current()).toEqual({ screen: "unreachable", offline: true, message: OFFLINE_TEXT });
    expect(down.gate.signedInKey()).toBeNull();
  });

  it("shows publik's own words when it refuses, and Retry runs the gate again", async () => {
    let busy = true;
    const h = harness({
      "POST /api/v1/installs": () => (busy ? json(503, { error: { type: "installs_unavailable", message: "Provisioning is temporarily unavailable." } }) : minted()),
      "GET /api/v1/wallet": wallet("anonymous"),
    });
    await h.gate.start();
    expect(h.gate.current()).toEqual({ screen: "unreachable", offline: false, message: "Provisioning is temporarily unavailable." });
    busy = false;
    await h.gate.start();
    expect(h.gate.current().screen).toBe("sign_in");
  });

  it("a build without an app token cannot sign in, and calls nothing", async () => {
    for (const token of [null, "", "pat_other-app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const h = harness({}, { token });
      await h.gate.start();
      expect(h.gate.current()).toEqual({ screen: "no_token", message: NO_TOKEN_TEXT });
      expect(h.calls).toEqual([]);
    }
  });

  it("goes back to Sign in when publik says the install is no longer signed in", async () => {
    let claimed = true;
    const h = harness({ "GET /api/v1/wallet": () => wallet(claimed ? "claimed" : "anonymous")(), "POST /api/v1/telemetry": () => new Response(null, { status: 204 }) }, { stored: { install_id: INSTALL, key: KEY, claim_url: null } });
    await h.gate.start();
    expect(h.gate.signedInKey()).toBe(KEY);
    claimed = false;
    h.gate.lost("signed_out");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.gate.current().screen).toBe("sign_in");
    expect(h.gate.signedInKey()).toBeNull();
  });

  it("sends no usage event when usage counting is off", async () => {
    const h = harness({ "GET /api/v1/wallet": wallet("claimed") }, { stored: { install_id: INSTALL, key: KEY, claim_url: null }, usageOff: true });
    await h.gate.start();
    expect(h.gate.current().screen).toBe("signed_in");
    expect(h.calls.some((c) => c.path === "/api/v1/telemetry")).toBe(false);
  });
});
