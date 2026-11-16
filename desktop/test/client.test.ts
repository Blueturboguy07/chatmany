import { describe, expect, it } from "vitest";
import { ChatmanyClient, isConsentUrl, readBilling, readProgress } from "../src/main/chatmany";
import { CONNECT_ERROR_TEXT, OFFLINE_TEXT } from "../src/shared/messages";

const ORIGIN = "https://publikhq.com";
const KEY = "pk_live_abc_secret";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(answer: (url: URL, init: RequestInit) => Response | Promise<Response>, options: { key?: string | null; online?: boolean } = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const lost: string[] = [];
  const c = new ChatmanyClient({
    origin: ORIGIN,
    fetch: (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      return answer(url, init);
    }) as unknown as typeof fetch,
    key: () => (options.key === undefined ? KEY : options.key),
    isOnline: () => options.online ?? true,
    onAuthLost: (kind) => void lost.push(kind),
  });
  return { c, calls, lost };
}

describe("the chatmany client", () => {
  it("calls nothing without a key", async () => {
    const h = client(() => json(200, {}), { key: null });
    expect(await h.c.status()).toMatchObject({ ok: false, error: "not_signed_in" });
    expect(await h.c.api("campaigns", "", "GET")).toMatchObject({ ok: false, error: "not_signed_in" });
    expect(h.calls).toEqual([]);
  });

  it("sends the key as a bearer to publik's chatmany routes, never in the address", async () => {
    const h = client(() => json(200, { connected: false }));
    await h.c.status("abcdefgh12345678");
    const call = h.calls[0]!;
    expect(call.url.toString()).toBe(`${ORIGIN}/api/v1/chatmany/status?connect_id=abcdefgh12345678`);
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.init.redirect).toBe("error");
  });

  it("drops a connect id that does not look like one", async () => {
    const h = client(() => json(200, { connected: false }));
    await h.c.status("../../x");
    expect(h.calls[0]!.url.search).toBe("");
  });

  it("reads a connect's progress strictly", () => {
    expect(readProgress({ state: "connected" })).toEqual({ state: "connected" });
    expect(readProgress({ state: "failed", error: "personal_account" })).toEqual({ state: "failed", error: "personal_account", message: CONNECT_ERROR_TEXT.personal_account });
    expect(readProgress({ state: "failed", error: "something new" })).toEqual({ state: "failed", error: "failed", message: CONNECT_ERROR_TEXT.failed });
    expect(readProgress({ state: "ok" })).toEqual({ state: "unknown" });
    expect(readProgress(null)).toEqual({ state: "unknown" });
  });

  it("accepts only Instagram's own consent page as the connect link", async () => {
    expect(isConsentUrl("https://www.instagram.com/oauth/authorize?client_id=1")).toBe(true);
    expect(isConsentUrl("http://www.instagram.com/oauth/authorize")).toBe(false);
    expect(isConsentUrl("https://instagram.com.evil.example/oauth")).toBe(false);
    expect(isConsentUrl("https://user:pw@www.instagram.com/")).toBe(false);
    const bad = client(() => json(200, { url: "https://evil.example/consent", connect_id: "abcdefgh12345678", expires_at: 1 }));
    expect(await bad.c.connectUrl()).toMatchObject({ ok: false, status: 502 });
    const good = client(() => json(200, { url: "https://www.instagram.com/oauth/authorize?state=app1.x", connect_id: "abcdefgh12345678", expires_at: 1 }));
    expect(await good.c.connectUrl()).toEqual({ ok: true, data: { url: "https://www.instagram.com/oauth/authorize?state=app1.x", connect_id: "abcdefgh12345678", expires_at: 1 } });
    expect(good.calls[0]!.init.method).toBe("POST");
  });

  it("says offline or not reachable when publik does not answer", async () => {
    const down = client(() => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    });
    expect(await down.c.status()).toMatchObject({ ok: false, status: 0, error: "unreachable" });
    const offline = client(
      () => {
        throw new TypeError("fetch failed");
      },
      { online: false },
    );
    expect(await offline.c.status()).toEqual({ ok: false, status: 0, error: "offline", message: OFFLINE_TEXT });
  });

  it("tells the gate when the key is gone or the install is signed out", async () => {
    const revoked = client(() => json(401, { error: { type: "key_revoked", message: "This publik API key was revoked." } }));
    const r = await revoked.c.status();
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(r.ok ? "" : r.message).toBe("Your publik sign-in ended. Sign in again.");
    expect(revoked.lost).toEqual(["revoked"]);
    const signedOut = client(() => json(403, { error: { type: "not_signed_in", message: "x" } }));
    await signedOut.c.api("campaigns", "", "GET");
    expect(signedOut.lost).toEqual(["signed_out"]);
  });

  it("turns the service's refusals into the builder's words", async () => {
    const h = client(() => json(400, { error: { type: "campaigns[0].media_id is required", message: "Pick the post this automation watches." } }));
    const res = await h.c.api("campaigns", "", "POST", { campaign: {} });
    expect(res).toMatchObject({ ok: false, status: 400, message: "Pick the post this automation watches." });
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ campaign: {} });
  });

  it("fetches the CSV as text", async () => {
    const h = client(() => new Response("username,state\n@ada,DONE\n", { status: 200, headers: { "content-type": "text/csv" } }));
    expect(await h.c.exportCsv("guide-1")).toEqual({ ok: true, data: "username,state\n@ada,DONE\n" });
    expect(h.calls[0]!.url.toString()).toBe(`${ORIGIN}/api/v1/chatmany/api/contacts/export?campaign_id=guide-1`);
  });
});

describe("the billing part of a status answer", () => {
  const GOOD = {
    can_pay: false,
    notice: { title: "Replies are paused. Your publik balance is empty.", body: "chatmany sends no DMs and no public replies while your balance is empty." },
    usage: { hosting_share: 0.12, used_share: 0.4, resets_at: "2026-12-01T00:00:00Z", prepaid_left_share: null, headline: "chatmany used 12% of your plan’s monthly limit.", detail: "All your apps used 40%. The limit resets on Dec 1.", cost: "Hosting is charged at what it costs publik, plus 10%." },
  };

  it("passes publik's words and shares through", async () => {
    expect(readBilling(GOOD)).toEqual(GOOD);
    const h = client(() => json(200, { connected: false, billing: GOOD }));
    const res = await h.c.status();
    expect(res.ok && res.data.billing).toEqual(GOOD);
  });

  it("never lets an amount or a broken answer through", () => {
    expect(readBilling({ ...GOOD, usage: { ...GOOD.usage, headline: "chatmany used $4.20 this month." } })).toBeNull();
    expect(readBilling({ ...GOOD, usage: { ...GOOD.usage, cost: "about 3 USD" } })).toBeNull();
    expect(readBilling({ ...GOOD, notice: null })).toBeNull();
    expect(readBilling({ can_pay: "yes", usage: GOOD.usage })).toBeNull();
    expect(readBilling(null)).toBeNull();
    expect(readBilling({ ...GOOD, usage: { ...GOOD.usage, hosting_share: 7, used_share: -1 } })?.usage).toMatchObject({ hosting_share: 1, used_share: 0 });
    expect(readBilling({ ...GOOD, can_pay: true })?.notice).toBeNull();
  });
});
