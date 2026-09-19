// Per-tenant secrets at rest.

import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, randomToken, timingSafeEqual } from "../src/tenant/crypto";
import { createTenant, tenantAccessToken, tenantAppSecret, saveTenantToken } from "../src/tenant/registry";
import { makeHostedEnv } from "./helpers/hostedEnv";

const KEK = "a-kek-that-is-at-least-thirty-two-chars";
const OTHER_KEK = "a-different-kek-also-long-enough-here!!";

describe("AES-256-GCM secrets at rest", () => {
  it("round-trips a token for its own tenant", async () => {
    const blob = await encryptSecret(KEK, "t_alpha", "IGQWRP-super-secret-token");
    expect(blob).toMatch(/^v1:/);
    expect(blob).not.toContain("IGQWRP");
    expect(await decryptSecret([KEK], "t_alpha", blob)).toBe("IGQWRP-super-secret-token");
  });

  it("will not open one tenant's secret as another tenant (the tenant id is the AAD)", async () => {
    const blob = await encryptSecret(KEK, "t_alpha", "alpha-token");
    await expect(decryptSecret([KEK], "t_beta", blob)).rejects.toThrow(/cannot decrypt/);
  });

  it("will not open with the wrong KEK", async () => {
    const blob = await encryptSecret(KEK, "t_alpha", "alpha-token");
    await expect(decryptSecret([OTHER_KEK], "t_alpha", blob)).rejects.toThrow(/cannot decrypt/);
  });

  it("opens with the previous KEK during a rotation", async () => {
    const blob = await encryptSecret(OTHER_KEK, "t_alpha", "alpha-token");
    expect(await decryptSecret([KEK, OTHER_KEK], "t_alpha", blob)).toBe("alpha-token");
  });

  it("uses a fresh IV, so the same secret never produces the same ciphertext", async () => {
    const a = await encryptSecret(KEK, "t_alpha", "same");
    const b = await encryptSecret(KEK, "t_alpha", "same");
    expect(a).not.toBe(b);
  });

  it("refuses a KEK that is too short to be random", async () => {
    await expect(encryptSecret("short", "t_alpha", "x")).rejects.toThrow(/TOKEN_KEK/);
  });

  it("randomToken is unique and hex", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomToken(8)));
    expect(seen.size).toBe(50);
    expect([...seen][0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("timingSafeEqual compares without leaking the length as an early match", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("the registry stores nothing in the clear", () => {
  it("keeps the app secret and the token encrypted, and decrypts only through the accessors", async () => {
    const { env } = makeHostedEnv();
    const { tenant } = await createTenant(env, { meta_app_secret: "app-secret-value" });
    await saveTenantToken(env, tenant.tenant_id, "token-value", Math.floor(Date.now() / 1000) + 5_184_000);

    const row = await env.DB.prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .bind(tenant.tenant_id)
      .first<Record<string, string>>();
    expect(row?.meta_app_secret_enc).not.toContain("app-secret-value");
    expect(row?.meta_token_encrypted).not.toContain("token-value");
    expect(JSON.stringify(row)).not.toContain("app-secret-value");

    const fresh = await env.DB.prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .bind(tenant.tenant_id)
      .first<Parameters<typeof tenantAppSecret>[1]>();
    expect(await tenantAppSecret(env, fresh!)).toBe("app-secret-value");
    expect(await tenantAccessToken(env, fresh!)).toBe("token-value");
  });
});
