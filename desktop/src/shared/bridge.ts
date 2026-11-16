/**
 * What the window may ask the main process, and the shapes it gets back.
 *
 * The window (renderer) never holds the publik key and never calls the
 * network itself: it asks the main process through the preload bridge
 * (`window.chatmany`), and the main process calls publik with the key it
 * keeps in the OS keychain. Every workspace call is refused while the
 * sign-in gate is not passed.
 */
import type { ConnectError } from "./messages";
import type { StatusView } from "./types";

/** The sign-in gate, as the window draws it. Never carries the key. */
export type GateView =
  | { screen: "starting" }
  /** publik did not answer. `offline`: this computer has no network at all. */
  | { screen: "unreachable"; offline: boolean; message: string }
  /** This build has no publik app token, so it cannot sign in. */
  | { screen: "no_token"; message: string }
  | { screen: "sign_in"; note: string | null; waiting: boolean }
  | { screen: "signed_in"; handle: string | null };

/** Every answer from publik, after the main process read it. `status` 0: publik did not answer. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message: string };

/** How one Instagram connect is going (GET /api/v1/chatmany/status?connect_id=). */
export type ConnectProgress =
  | { state: "waiting" }
  | { state: "connected" }
  | { state: "failed"; error: ConnectError; message: string }
  /** publik no longer knows this connect (it is older than 15 minutes). */
  | { state: "unknown" };

/**
 * Paying for hosted chatmany (GET /api/v1/chatmany/status, publik
 * lib/chatmany-app/billing.ts): the hosted page's "Replies are paused"
 * notice and its "What chatmany uses" box, in its words. Shares (0..1) and
 * sentences only, never an amount. null: publik did not read it this time.
 */
export interface AppBilling {
  can_pay: boolean;
  notice: { title: string; body: string } | null;
  usage: {
    hosting_share: number | null;
    used_share: number | null;
    resets_at: string | null;
    prepaid_left_share: number | null;
    headline: string;
    detail: string | null;
    cost: string;
  };
}

export type StatusAnswer = StatusView & { connect?: ConnectProgress; billing?: AppBilling | null };

export interface ConnectStarted {
  connect_id: string;
  /** Unix seconds. */
  expires_at: number;
}

export type SaveResult = { ok: true; saved: boolean } | { ok: false; message: string };

export interface ChatmanyBridge {
  gate: {
    get(): Promise<GateView>;
    signIn(): Promise<void>;
    retry(): Promise<void>;
    /** Called with every new gate state. Returns the unsubscribe. */
    onChange(listener: (view: GateView) => void): () => void;
  };
  workspace: {
    status(connectId?: string): Promise<ApiResult<StatusAnswer>>;
    /** Asks publik for a one-time Instagram link and opens it in the system browser. */
    connect(): Promise<ApiResult<ConnectStarted>>;
    /** Opens the last Instagram link again (same link, still single use). */
    reopenConnect(): Promise<boolean>;
    disconnect(): Promise<ApiResult<{ ok: boolean; deleted: boolean }>>;
    api<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<ApiResult<T>>;
    /** Downloads the people list as CSV and asks where to save it. */
    exportCsv(campaignId: string | null): Promise<SaveResult>;
  };
  /** Opens a publik or Instagram page in the system browser. Other addresses are refused. */
  openExternal(url: string): Promise<boolean>;
  info: { version: string; platform: string };
}

/** The IPC channel names. The preload has its own copy (a sandboxed preload cannot import files). */
export const CHANNELS = {
  gateGet: "gate:get",
  gateSignIn: "gate:sign-in",
  gateRetry: "gate:retry",
  gateChanged: "gate:changed",
  status: "workspace:status",
  connect: "workspace:connect",
  reopenConnect: "workspace:reopen-connect",
  disconnect: "workspace:disconnect",
  api: "workspace:api",
  exportCsv: "workspace:export-csv",
  openExternal: "app:open-external",
} as const;

/**
 * The workspace paths the window may ask for, the same list publik's proxy
 * allows (lib/chatmany-hosted/proxy.ts there). publik checks again; this
 * copy stops anything else before it leaves the computer.
 */
const API_PATHS: Readonly<Record<string, readonly ("GET" | "POST")[]>> = {
  status: ["GET"],
  media: ["GET"],
  campaigns: ["GET", "POST"],
  "campaigns/status": ["POST"],
  "campaigns/archive": ["POST"],
  "campaigns/delete": ["POST"],
  dashboard: ["GET"],
  contacts: ["GET"],
};

const QUERY_KEYS = new Set(["archived", "campaign_id", "days"]);

/** `path` as the window sent it (with an optional query), or null when it is not on the list. */
export function allowedApiPath(raw: unknown, method: unknown): { path: string; query: string } | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const verb = method === undefined ? "GET" : method;
  if (verb !== "GET" && verb !== "POST") return null;
  const [path, query = ""] = raw.split("?", 2) as [string, string?];
  if (!Object.hasOwn(API_PATHS, path) || !API_PATHS[path]!.includes(verb)) return null;
  const params = new URLSearchParams(query);
  for (const key of params.keys()) if (!QUERY_KEYS.has(key)) return null;
  return { path, query: params.toString() };
}
