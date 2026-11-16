import type { ApiResult, ConnectProgress, ConnectStarted, StatusAnswer } from "../shared/bridge";
import { CONNECT_ERROR_TEXT, OFFLINE_TEXT, isConnectError, plainError } from "../shared/messages";

/**
 * chatmany's calls to publik, made by the main process with the install key.
 * Routes (publik app/api/v1/chatmany/*):
 *
 *   GET  /api/v1/chatmany/status[?connect_id=]   the connected account (and how one connect is going)
 *   POST /api/v1/chatmany/connect-url            a one-time Instagram consent link
 *   POST /api/v1/chatmany/disconnect             disconnect and delete everything
 *   *    /api/v1/chatmany/api/<path>             the workspace (same allow-list as the web page)
 *
 * Never throws: every failure comes back as `{ok:false, status, error, message}`
 * with the message in plain words. A 401 or a "not signed in" answer tells
 * the gate, which shows Sign in with publik again.
 */
export interface ClientDeps {
  origin: string;
  fetch: typeof fetch;
  /** The key, or null while the gate is not passed. */
  key(): string | null;
  isOnline(): boolean;
  onAuthLost(kind: "revoked" | "signed_out"): void;
}

const TIMEOUT_MS = 25_000;
const CONNECT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Hosts an Instagram consent page lives on. The connect link must be one of these, over https. */
const CONSENT_HOSTS = new Set(["www.instagram.com", "instagram.com", "api.instagram.com", "www.facebook.com", "facebook.com", "m.facebook.com"]);

export function isConsentUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && CONSENT_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;

function codeOf(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const e = (body as Json).error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as Json).type === "string") return (e as Json).type as string;
  return "";
}

export const NOT_SIGNED_IN = { ok: false, status: 401, error: "not_signed_in", message: "Sign in with publik first." } as const satisfies ApiResult<never>;

export class ChatmanyClient {
  constructor(private readonly deps: ClientDeps) {}

  private async call<T>(method: "GET" | "POST", path: string, init: { query?: string; body?: unknown; text?: boolean } = {}): Promise<ApiResult<T>> {
    const key = this.deps.key();
    if (!key) return NOT_SIGNED_IN;
    const url = `${this.deps.origin}/api/v1/chatmany/${path}${init.query ? `?${init.query}` : ""}`;
    let res: Response;
    try {
      res = await this.deps.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: init.text ? "text/csv" : "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // No answer at all (no network, refused, timed out): never a refusal by publik.
      const offline = !this.deps.isOnline();
      return { ok: false, status: 0, error: offline ? "offline" : "unreachable", message: offline ? OFFLINE_TEXT : plainError(0) };
    }

    if (res.ok && init.text) return { ok: true, data: (await res.text()) as T };
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) return { ok: true, data: body as T };

    const code = codeOf(body);
    if (res.status === 401) this.deps.onAuthLost("revoked");
    else if (res.status === 403 && code === "not_signed_in") this.deps.onAuthLost("signed_out");
    return { ok: false, status: res.status, error: code || `http_${res.status}`, message: plainError(res.status, code) };
  }

  async status(connectId?: string): Promise<ApiResult<StatusAnswer>> {
    const query = connectId && CONNECT_ID.test(connectId) ? `connect_id=${encodeURIComponent(connectId)}` : undefined;
    const res = await this.call<StatusAnswer>("GET", "status", { query });
    if (!res.ok) return res;
    const connect = res.data.connect ? readProgress(res.data.connect) : undefined;
    return { ok: true, data: { ...res.data, ...(connect ? { connect } : {}) } };
  }

  /** The Instagram link, checked to be Instagram's own consent page. */
  async connectUrl(): Promise<ApiResult<ConnectStarted & { url: string }>> {
    const res = await this.call<{ url?: unknown; connect_id?: unknown; expires_at?: unknown }>("POST", "connect-url", { body: {} });
    if (!res.ok) return res;
    const { url, connect_id, expires_at } = res.data;
    if (!isConsentUrl(url) || typeof connect_id !== "string" || !CONNECT_ID.test(connect_id)) {
      return { ok: false, status: 502, error: "bad_connect_url", message: plainError(502) };
    }
    return { ok: true, data: { url, connect_id, expires_at: typeof expires_at === "number" ? expires_at : 0 } };
  }

  disconnect(): Promise<ApiResult<{ ok: boolean; deleted: boolean }>> {
    return this.call("POST", "disconnect", { body: {} });
  }

  /** `path` and `query` were checked against the allow-list (shared/bridge.ts allowedApiPath). */
  api<T>(path: string, query: string, method: "GET" | "POST", body?: unknown): Promise<ApiResult<T>> {
    return this.call<T>(method, `api/${path}`, { query: query || undefined, body: method === "POST" ? (body ?? {}) : undefined });
  }

  exportCsv(campaignId: string | null): Promise<ApiResult<string>> {
    const query = campaignId ? `campaign_id=${encodeURIComponent(campaignId)}` : undefined;
    return this.call<string>("GET", "api/contacts/export", { query, text: true });
  }
}

/** publik's `connect` field, read strictly: an unknown shape is "unknown", never a success. */
export function readProgress(raw: unknown): ConnectProgress {
  if (!raw || typeof raw !== "object") return { state: "unknown" };
  const p = raw as Json;
  if (p.state === "waiting") return { state: "waiting" };
  if (p.state === "connected") return { state: "connected" };
  if (p.state === "failed") {
    const error = isConnectError(p.error) ? p.error : "failed";
    return { state: "failed", error, message: CONNECT_ERROR_TEXT[error] };
  }
  return { state: "unknown" };
}
