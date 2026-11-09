// The creator-facing surface publik proxies to (path T): connect through the shared publik Meta
// app, then the per-tenant JSON API. What matters here is that a token is stored only encrypted,
// only for the right tenant, and that one tenant's routes can never read another tenant's rows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleHosted } from "../src/routes/hosted";
import { pollIntervalSeconds } from "../src/tenant/do";
import { createTenant, getTenant } from "../src/tenant/registry";
import { makeHostedEnv } from "./helpers/hostedEnv";
import type { HostedEnv } from "../src/types";

const ORIGIN = "https://chatmany.test";
const REDIRECT = "https://publikhq.test/api/chatmany/callback";
const LONG_TOKEN = "IGAA-long-lived-token-plaintext";

function campaign(id: string) {
  return {
    campaign_id: id,
    name: id,
    media_id: "media-1",
    keywords: ["link"],
    deliver_in_opening: true,
    reward: { type: "link", value: "https://publikhq.com/x" },
    copy: { opening: "here it is {reward}", delivery: "here you go {reward}" },
  };
}

async function call(
  env: HostedEnv,
  ctx: ExecutionContext,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = "admin-token",
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleHosted(env, req, new URL(req.url), ctx);
  if (!res) throw new Error("route not handled");
  return res;
}

interface FakeInstagram {
  accountType?: string;
  userId?: string;
  longExchange?: { status: number; body: unknown };
}

/** Stand in for Instagram's three connect calls plus the media read. Records every URL hit. */
function fakeInstagram(opts: FakeInstagram = {}): string[] {
  const hits: string[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    hits.push(`${u.origin}${u.pathname}`);
    if (u.hostname === "api.instagram.com" && u.pathname === "/oauth/access_token") {
      return reply({ access_token: "short-token", user_id: opts.userId ?? "111", permissions: ["instagram_business_basic"] });
    }
    if (u.hostname === "graph.instagram.com" && u.pathname === "/access_token") {
      if (opts.longExchange) return reply(opts.longExchange.body, opts.longExchange.status);
      return reply({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5_184_000 });
    }
    if (u.hostname === "graph.instagram.com" && u.pathname.endsWith("/me")) {
      return reply({
        user_id: opts.userId ?? "111",
        username: "creator",
        account_type: opts.accountType ?? "BUSINESS",
        profile_picture_url: "https://cdn.test/p.jpg",
      });
    }
    if (u.hostname === "graph.instagram.com" && u.pathname.endsWith("/me/media")) {
      return reply({ data: [{ id: "media-1", caption: "hello" }] });
    }
    return reply({ error: { message: "unexpected call" } }, 500);
  });
  return hits;
}

afterEach(() => vi.unstubAllGlobals());

describe("the control plane stays behind the admin token", () => {
  it("refuses the new routes without it", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, {});
    for (const [method, path] of [
      ["GET", `/hosted/tenants?publik_user_id=u1`],
      ["GET", `/hosted/tenants/${tenant.tenant_id}/authorize-url?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${"s".repeat(32)}`],
      ["POST", `/hosted/tenants/${tenant.tenant_id}/oauth`],
      ["GET", `/hosted/tenants/${tenant.tenant_id}/api/campaigns`],
    ] as const) {
      expect((await call(env, ctx, method, path, method === "POST" ? {} : undefined, null)).status).toBe(401);
      expect((await call(env, ctx, method, path, method === "POST" ? {} : undefined, "wrong")).status).toBe(401);
    }
  });
});

describe("POST /hosted/tenants for the shared publik app", () => {
  it("gives a publik user the tenant they already have instead of a second one", async () => {
    const { env, ctx } = makeHostedEnv();
    const ask = { publik_user_id: "user-a", meta_app_kind: "publik" };
    const first = (await (await call(env, ctx, "POST", "/hosted/tenants", ask)).json()) as { tenant: { tenant_id: string }; existing?: boolean };
    const again = (await (await call(env, ctx, "POST", "/hosted/tenants", ask)).json()) as { tenant: { tenant_id: string }; existing?: boolean };
    expect(first.existing).toBeUndefined();
    expect(again.existing).toBe(true);
    expect(again.tenant.tenant_id).toBe(first.tenant.tenant_id);

    const other = (await (await call(env, ctx, "POST", "/hosted/tenants", { ...ask, publik_user_id: "user-b" })).json()) as { tenant: { tenant_id: string } };
    expect(other.tenant.tenant_id).not.toBe(first.tenant.tenant_id);

    const list = (await (await call(env, ctx, "GET", "/hosted/tenants?publik_user_id=user-a")).json()) as { tenants: unknown[] };
    expect(list.tenants).toHaveLength(1);
  });

  it("still makes a new tenant each time for a creator's own app", async () => {
    const { env, ctx } = makeHostedEnv();
    const ask = { publik_user_id: "user-a", meta_app_kind: "creator" };
    const one = (await (await call(env, ctx, "POST", "/hosted/tenants", ask)).json()) as { tenant: { tenant_id: string } };
    const two = (await (await call(env, ctx, "POST", "/hosted/tenants", ask)).json()) as { tenant: { tenant_id: string } };
    expect(two.tenant.tenant_id).not.toBe(one.tenant.tenant_id);
  });
});

describe("GET /hosted/tenants?publik_user_id=", () => {
  it("returns only that publik user's tenant", async () => {
    const { env, ctx } = makeHostedEnv();
    const a = await createTenant(env, { publik_user_id: "user-a" });
    await createTenant(env, { publik_user_id: "user-b" });
    const res = await call(env, ctx, "GET", "/hosted/tenants?publik_user_id=user-a");
    const body = (await res.json()) as { tenants: Array<{ tenant_id: string }> };
    expect(body.tenants.map((t) => t.tenant_id)).toEqual([a.tenant.tenant_id]);
    const none = await call(env, ctx, "GET", "/hosted/tenants?publik_user_id=nobody");
    expect(((await none.json()) as { tenants: unknown[] }).tenants).toEqual([]);
  });
});

describe("GET /hosted/tenants/{id}/authorize-url", () => {
  it("builds Instagram's consent URL from the shared app", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, { publik_user_id: "u1", meta_app_kind: "publik" });
    const state = "s".repeat(32);
    const res = await call(
      env,
      ctx,
      "GET",
      `/hosted/tenants/${tenant.tenant_id}/authorize-url?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}`,
    );
    expect(res.status).toBe(200);
    const u = new URL(((await res.json()) as { url: string }).url);
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("app-1");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("scope")).toContain("instagram_business_manage_messages");
    expect(u.toString()).not.toContain("secret-1");
  });

  it("fails closed without a shared app, a non-https redirect, or a short state", async () => {
    const bare = makeHostedEnv();
    const t0 = await createTenant(bare.env, {});
    const q = `redirect_uri=${encodeURIComponent(REDIRECT)}&state=${"s".repeat(32)}`;
    expect((await call(bare.env, bare.ctx, "GET", `/hosted/tenants/${t0.tenant.tenant_id}/authorize-url?${q}`)).status).toBe(503);

    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, {});
    const base = `/hosted/tenants/${tenant.tenant_id}/authorize-url`;
    expect((await call(env, ctx, "GET", `${base}?redirect_uri=http%3A%2F%2Fevil.test%2Fcb&state=${"s".repeat(32)}`)).status).toBe(400);
    expect((await call(env, ctx, "GET", `${base}?redirect_uri=${encodeURIComponent(REDIRECT)}&state=short`)).status).toBe(400);
  });
});

describe("POST /hosted/tenants/{id}/oauth", () => {
  it("stores the token encrypted for that tenant, marks it active and arms, without asking Meta for deliveries", async () => {
    const { env, ctx, dispatches } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, { publik_user_id: "u1", meta_app_kind: "publik" });
    const hits = fakeInstagram();

    const res = await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { code: "abc#_", redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(LONG_TOKEN);
    expect(JSON.parse(text).tenant.username).toBe("creator");

    const row = (await getTenant(env.DB, tenant.tenant_id))!;
    expect(row.status).toBe("active");
    expect(row.ig_user_id).toBe("111");
    expect(row.meta_app_id).toBe("app-1");
    expect(row.meta_token_encrypted).toBeTruthy();
    expect(row.meta_token_encrypted).not.toContain(LONG_TOKEN);
    expect(row.meta_token_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 50 * 86400);

    expect(hits[0]).toBe("https://api.instagram.com/oauth/access_token");
    // No /subscribe: the shared app has one callback URL and no ingress that routes to a tenant yet.
    expect(dispatches.map((d) => d.path)).toEqual(["/arm"]);
    expect(hits.some((h) => h.includes("subscribed_apps"))).toBe(false);
    expect(dispatches.every((d) => d.tenantId === tenant.tenant_id)).toBe(true);
  });

  it("refuses a personal account and leaves the tenant unconnected", async () => {
    const { env, ctx, dispatches } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, { publik_user_id: "u1" });
    fakeInstagram({ accountType: "PERSONAL" });
    const res = await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { code: "abc", redirect_uri: REDIRECT });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("personal_account");
    const row = (await getTenant(env.DB, tenant.tenant_id))!;
    expect(row.meta_token_encrypted).toBeNull();
    expect(row.status).toBe("connecting");
    expect(dispatches).toEqual([]);
  });

  it("refuses an Instagram account that another tenant already holds", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const a = await createTenant(env, { publik_user_id: "user-a" });
    const b = await createTenant(env, { publik_user_id: "user-b" });
    fakeInstagram({ userId: "777" });
    expect((await call(env, ctx, "POST", `/hosted/tenants/${a.tenant.tenant_id}/oauth`, { code: "c1", redirect_uri: REDIRECT })).status).toBe(200);
    const res = await call(env, ctx, "POST", `/hosted/tenants/${b.tenant.tenant_id}/oauth`, { code: "c2", redirect_uri: REDIRECT });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("account_connected_elsewhere");
    expect((await getTenant(env.DB, b.tenant.tenant_id))!.meta_token_encrypted).toBeNull();
    // The same creator reconnecting the same account is fine.
    expect((await call(env, ctx, "POST", `/hosted/tenants/${a.tenant.tenant_id}/oauth`, { code: "c3", redirect_uri: REDIRECT })).status).toBe(200);
  });

  it("names the pre-approval failure instead of blaming the creator", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, {});
    fakeInstagram({
      longExchange: { status: 400, body: { error: { message: "Unsupported request - method type: get", code: 100 } } },
    });
    const res = await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { code: "abc", redirect_uri: REDIRECT });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("app_not_approved_for_account");
  });

  it("needs a code and an https redirect", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, {});
    fakeInstagram();
    expect((await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { redirect_uri: REDIRECT })).status).toBe(400);
    expect((await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { code: "abc", redirect_uri: "http://x.test/cb" })).status).toBe(400);
  });
});

describe("/hosted/tenants/{id}/api/* is bound to one tenant", () => {
  it("reports not connected before the creator connects", async () => {
    const { env, ctx } = makeHostedEnv();
    const { tenant } = await createTenant(env, {});
    const res = await call(env, ctx, "GET", `/hosted/tenants/${tenant.tenant_id}/api/status`);
    expect(await res.json()).toEqual({ connected: false });
    expect((await call(env, ctx, "GET", `/hosted/tenants/${tenant.tenant_id}/api/media`)).status).toBe(400);
  });

  it("shows the profile and media of the connected account", async () => {
    const { env, ctx } = makeHostedEnv({ APP_ID: "app-1", APP_SECRET: "secret-1" });
    const { tenant } = await createTenant(env, { publik_user_id: "u1" });
    fakeInstagram();
    await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/oauth`, { code: "abc", redirect_uri: REDIRECT });
    const status = (await (await call(env, ctx, "GET", `/hosted/tenants/${tenant.tenant_id}/api/status`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      connected: true,
      username: "creator",
      account_type: "BUSINESS",
      profile_picture_url: "https://cdn.test/p.jpg",
      ig_user_id: "111",
      token_expired: false,
    });
    expect(JSON.stringify(status)).not.toContain(LONG_TOKEN);
    const media = (await (await call(env, ctx, "GET", `/hosted/tenants/${tenant.tenant_id}/api/media`)).json()) as { media: Array<{ id: string }> };
    expect(media.media[0]!.id).toBe("media-1");
  });

  it("keeps one tenant's automations, numbers and contacts away from another", async () => {
    const { env, ctx, dispatches, settled } = makeHostedEnv();
    const a = (await createTenant(env, { publik_user_id: "user-a" })).tenant.tenant_id;
    const b = (await createTenant(env, { publik_user_id: "user-b" })).tenant.tenant_id;

    const saved = await call(env, ctx, "POST", `/hosted/tenants/${a}/api/campaigns`, { campaign: campaign("a-only"), active: true });
    expect(saved.status).toBe(200);
    await settled();
    expect(dispatches.map((d) => `${d.tenantId}${d.path}`)).toEqual([`${a}/arm`]);

    const listA = (await (await call(env, ctx, "GET", `/hosted/tenants/${a}/api/campaigns`)).json()) as { campaigns: Array<{ campaign_id: string; active: boolean }> };
    const listB = (await (await call(env, ctx, "GET", `/hosted/tenants/${b}/api/campaigns`)).json()) as { campaigns: unknown[] };
    expect(listA.campaigns.map((c) => c.campaign_id)).toEqual(["a-only"]);
    expect(listA.campaigns[0]!.active).toBe(true);
    expect(listB.campaigns).toEqual([]);

    // B cannot pause or delete A's automation by naming its id.
    await call(env, ctx, "POST", `/hosted/tenants/${b}/api/campaigns/status`, { campaign_id: "a-only", active: false });
    await call(env, ctx, "POST", `/hosted/tenants/${b}/api/campaigns/delete`, { campaign_id: "a-only" });
    const after = (await (await call(env, ctx, "GET", `/hosted/tenants/${a}/api/campaigns`)).json()) as { campaigns: Array<{ campaign_id: string; active: boolean }> };
    expect(after.campaigns).toHaveLength(1);
    expect(after.campaigns[0]!.active).toBe(true);

    const dashB = (await (await call(env, ctx, "GET", `/hosted/tenants/${b}/api/dashboard`)).json()) as { cards: { comments: number } };
    expect(dashB.cards.comments).toBe(0);
    expect(((await (await call(env, ctx, "GET", `/hosted/tenants/${b}/api/contacts`)).json()) as { contacts: unknown[] }).contacts).toEqual([]);
  });

  it("rejects an invalid automation and an unknown path", async () => {
    const { env, ctx } = makeHostedEnv();
    const { tenant } = await createTenant(env, {});
    const bad = await call(env, ctx, "POST", `/hosted/tenants/${tenant.tenant_id}/api/campaigns`, { campaign: { campaign_id: "x" } });
    expect(bad.status).toBe(400);
    expect((await call(env, ctx, "GET", `/hosted/tenants/${tenant.tenant_id}/api/nope`)).status).toBe(404);
    expect((await call(env, ctx, "GET", `/hosted/tenants/t_missing/api/campaigns`)).status).toBe(404);
  });
});

describe("poll cadence", () => {
  it("defaults to 90 seconds and never goes below the floor", () => {
    expect(pollIntervalSeconds({})).toBe(90);
    expect(pollIntervalSeconds({ HOSTED_POLL_INTERVAL_SECONDS: "junk" })).toBe(90);
    expect(pollIntervalSeconds({ HOSTED_POLL_INTERVAL_SECONDS: "15" })).toBe(15);
    expect(pollIntervalSeconds({ HOSTED_POLL_INTERVAL_SECONDS: "1" })).toBe(10);
  });
});
