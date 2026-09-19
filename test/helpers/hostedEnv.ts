// A HostedEnv backed by the in-memory D1 and a fake Durable Object namespace that records every
// dispatch instead of running one.

import { makeTestDb } from "./fakeD1";
import type { HostedEnv } from "../../src/types";

export interface DispatchRecord {
  tenantId: string;
  path: string;
  body: unknown;
}

export function makeHostedEnv(over: Partial<HostedEnv> = {}): {
  env: HostedEnv;
  dispatches: DispatchRecord[];
  ctx: ExecutionContext;
  settled: () => Promise<void>;
} {
  const dispatches: DispatchRecord[] = [];
  const pending: Promise<unknown>[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        dispatches.push({
          tenantId: url.searchParams.get("tenant") ?? "",
          path: url.pathname,
          body: await req.json().catch(() => null),
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    }),
  };
  const env = {
    DB: makeTestDb(),
    ASSETS: { fetch: async () => new Response("", { status: 404 }) },
    GRAPH_VERSION: "v23.0",
    MODE: "polling",
    POLL_INTERVAL_SECONDS: "90",
    REDIRECT_URI: "https://chatmany.test/auth/callback",
    APP_ID: "",
    APP_SECRET: "",
    OWNER_TOKEN: "",
    HOSTED: "1",
    TENANT: namespace as unknown as DurableObjectNamespace,
    TOKEN_KEK: "test-kek-of-at-least-32-characters-long",
    PUBLIK_API_BASE: "https://publikhq.test",
    INFRA_INGEST_TOKEN: "ingest-token",
    INFRA_ADMIN_TOKEN: "admin-token",
    ...over,
  } as unknown as HostedEnv;

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  return { env, dispatches, ctx, settled: async () => void (await Promise.all(pending)) };
}

/** Sign a body the way Meta does, for the signature tests. */
export async function sign(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
