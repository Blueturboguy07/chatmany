// The webhook ingress: per-tenant verify token, per-tenant signature, and what reaches the
// tenant's Durable Object.

import { describe, expect, it } from "vitest";
import { handleHosted } from "../src/routes/hosted";
import { createTenant, getTenant } from "../src/tenant/registry";
import { makeHostedEnv, sign } from "./helpers/hostedEnv";
import type { HostedEnv } from "../src/types";

const BODY = JSON.stringify({
  entry: [
    {
      id: "ig-1",
      changes: [
        {
          field: "comments",
          value: {
            id: "cm-1",
            text: "link please",
            timestamp: "2026-09-19T00:00:00+0000",
            from: { id: "user-1", username: "someone" },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
});

async function post(env: HostedEnv, ctx: ExecutionContext, tenantId: string, body: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;
  const req = new Request(`https://chatmany.test/webhook/${tenantId}`, { method: "POST", body, headers });
  return await handleHosted(env, req, new URL(req.url), ctx);
}

describe("GET /webhook/{tenant} — the handshake is per tenant", () => {
  it("answers the challenge only for that tenant's own verify token", async () => {
    const { env, ctx } = makeHostedEnv();
    const a = await createTenant(env, {});
    const b = await createTenant(env, {});

    const ok = await handleHosted(
      env,
      new Request("https://chatmany.test/"),
      new URL(
        `https://chatmany.test/webhook/${a.tenant.tenant_id}?hub.mode=subscribe&hub.challenge=CH&hub.verify_token=${a.webhook_verify_token}`,
      ),
      ctx,
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.text()).toBe("CH");

    // b's token must not open a's handshake.
    const crossed = await handleHosted(
      env,
      new Request("https://chatmany.test/"),
      new URL(
        `https://chatmany.test/webhook/${a.tenant.tenant_id}?hub.mode=subscribe&hub.challenge=CH&hub.verify_token=${b.webhook_verify_token}`,
      ),
      ctx,
    );
    expect(crossed?.status).toBe(403);
  });
});

describe("POST /webhook/{tenant} — signature verification", () => {
  it("rejects a delivery with no signature", async () => {
    const { env, ctx, dispatches } = makeHostedEnv();
    const { tenant } = await createTenant(env, { meta_app_secret: "secret-a" });
    const res = await post(env, ctx, tenant.tenant_id, BODY, null);
    expect(res?.status).toBe(401);
    expect(dispatches).toHaveLength(0);
  });

  it("rejects a delivery whose signature does not match the body", async () => {
    const { env, ctx, dispatches } = makeHostedEnv();
    const { tenant } = await createTenant(env, { meta_app_secret: "secret-a" });
    const res = await post(env, ctx, tenant.tenant_id, BODY, await sign("secret-a", "{}"));
    expect(res?.status).toBe(401);
    expect(dispatches).toHaveLength(0);
  });

  it("rejects a delivery signed with ANOTHER tenant's app secret", async () => {
    const { env, ctx, dispatches } = makeHostedEnv();
    const a = await createTenant(env, { meta_app_secret: "secret-a" });
    await createTenant(env, { meta_app_secret: "secret-b" });
    const res = await post(env, ctx, a.tenant.tenant_id, BODY, await sign("secret-b", BODY));
    expect(res?.status).toBe(401);
    expect(dispatches).toHaveLength(0);
  });

  it("rejects a delivery for a tenant that does not exist", async () => {
    const { env, ctx } = makeHostedEnv();
    const res = await post(env, ctx, "t_nope", BODY, await sign("secret-a", BODY));
    expect(res?.status).toBe(404);
  });

  it("accepts a correctly signed delivery, answers 200 at once, and hands it to that tenant's object", async () => {
    const { env, ctx, dispatches, settled } = makeHostedEnv();
    const { tenant } = await createTenant(env, { meta_app_secret: "secret-a" });
    const res = await post(env, ctx, tenant.tenant_id, BODY, await sign("secret-a", BODY));
    expect(res?.status).toBe(200);

    await settled();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.tenantId).toBe(tenant.tenant_id);
    expect(dispatches[0]!.path).toBe("/events");
    const events = (dispatches[0]!.body as { events: Array<{ comment_id: string }> }).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.comment_id).toBe("cm-1");

    // The first signed delivery is the proof webhooks are live: stop polling this tenant.
    const after = await getTenant(env.DB, tenant.tenant_id);
    expect(after?.mode).toBe("webhook");
    expect(after?.webhook_verified_at).toBeTruthy();
  });

  it("never answers our own comment", async () => {
    const { env, ctx, dispatches, settled } = makeHostedEnv();
    const { tenant } = await createTenant(env, { meta_app_secret: "secret-a" });
    await env.DB.prepare("UPDATE tenants SET ig_user_id = 'user-1' WHERE tenant_id = ?")
      .bind(tenant.tenant_id)
      .run();
    await post(env, ctx, tenant.tenant_id, BODY, await sign("secret-a", BODY));
    await settled();
    expect(dispatches).toHaveLength(0); // the only event in the body is from our own account
  });
});

describe("/hosted/* control plane", () => {
  it("refuses without the admin bearer token", async () => {
    const { env, ctx } = makeHostedEnv();
    const req = new Request("https://chatmany.test/hosted/tenants", { method: "GET" });
    const res = await handleHosted(env, req, new URL(req.url), ctx);
    expect(res?.status).toBe(401);
  });

  it("creates a tenant and hands back the six connect-page values, the verify token once", async () => {
    const { env, ctx } = makeHostedEnv();
    const req = new Request("https://chatmany.test/hosted/tenants", {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ publik_user_id: "u_1", meta_app_id: "111", meta_app_secret: "secret-a" }),
    });
    const res = await handleHosted(env, req, new URL(req.url), ctx);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, string> & { tenant: { tenant_id: string } };
    expect(body.webhook_url).toBe(`https://chatmany.test/webhook/${body.tenant.tenant_id}`);
    expect(body.redirect_uri).toBe(`https://chatmany.test/auth/callback/${body.tenant.tenant_id}`);
    expect(body.webhook_verify_token).toMatch(/^[0-9a-f]{48}$/);
    // The tenant view carries no secret material.
    expect(JSON.stringify(body.tenant)).not.toContain("secret-a");
  });
});
