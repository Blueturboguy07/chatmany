// Builds the per-invocation runtime (API client + send queue + engine) from stored auth.
// Returns null when no account is connected or the token has lapsed.

import { InstagramClient } from "./api/client";
import { SendQueue } from "./queue/queue";
import { Engine } from "./engine/engine";
import { getAuth, now } from "./db";
import type { AuthRow, Env } from "./types";

export interface Runtime {
  client: InstagramClient;
  queue: SendQueue;
  engine: Engine;
  auth: AuthRow;
  igUserId: string;
}

export async function buildRuntime(env: Env): Promise<Runtime | null> {
  const auth = await getAuth(env.DB);
  if (!auth) {
    console.warn("[chatmany] no Instagram account connected; skipping.");
    return null;
  }
  if (auth.expires_at <= now()) {
    console.warn("[chatmany] access token expired; owner must reconnect. Skipping.");
    return null;
  }
  const igUserId = auth.ig_user_id ?? "me";
  const client = new InstagramClient(auth.access_token, env.GRAPH_VERSION, igUserId);
  const queue = new SendQueue();
  const engine = new Engine(env.DB, client, queue, env);
  return { client, queue, engine, auth, igUserId };
}

/** Parse an ISO-8601 timestamp (Graph `created_time`/`timestamp`) to unix seconds. */
export function toUnixSeconds(iso: string | undefined): number {
  if (!iso) return now();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? now() : Math.floor(ms / 1000);
}
