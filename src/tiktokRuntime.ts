// Per-invocation TikTok runtime (client + send queue + engine) from the stored tiktok_auth row.
// Returns null when no TikTok account is connected or the tokens cannot be made valid.

import { TikTokClient } from "./api/tiktok";
import { SendQueue } from "./queue/queue";
import { TikTokEngine } from "./engine/tiktokEngine";
import { getTikTokAuth, now } from "./db";
import { refreshTikTokTokenIfDue } from "./auth/tiktokRefresh";
import type { Env, TikTokAuthRow } from "./types";

export interface TikTokRuntime {
  client: TikTokClient;
  queue: SendQueue;
  engine: TikTokEngine;
  auth: TikTokAuthRow;
  businessId: string;
}

export async function buildTikTokRuntime(env: Env): Promise<TikTokRuntime | null> {
  let auth = await getTikTokAuth(env.DB);
  if (!auth) return null;
  if (auth.expires_at <= now() + 60) {
    // The 1-day access token lapsed between cron ticks (or the Worker was idle): roll it now.
    const r = await refreshTikTokTokenIfDue(env, { force: true });
    if (r.status !== "refreshed") {
      console.warn(`[chatmany:tiktok] access token unusable (${r.status}${r.detail ? `: ${r.detail}` : ""}); skipping.`);
      return null;
    }
    auth = (await getTikTokAuth(env.DB))!;
  }
  const client = new TikTokClient(auth.access_token, auth.business_id);
  // Business Messaging allows 10 QPS; comment endpoints 40 QPM per account. 1.5s spacing keeps
  // a burst of nudges under the comment cap without a separate limiter.
  const queue = new SendQueue({ minIntervalMs: 1500 });
  const engine = new TikTokEngine(env.DB, client, queue);
  return { client, queue, engine, auth, businessId: auth.business_id };
}
