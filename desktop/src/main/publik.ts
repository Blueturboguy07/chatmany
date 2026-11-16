// publik.ts: Sign in with publik and usage counting for chatmany (Electron main process).
//
// This is publik's TypeScript module (publikhq.com/sdk/publik.ts.md) shaped for this app:
//   1. it loads this computer's publik key, or provisions one (POST /api/v1/installs);
//   2. it shows "Sign in with publik" until GET /api/v1/wallet says "claimed". The button opens
//      the sign-in page in the SYSTEM browser; the app asks publik every 3 seconds, for at most
//      10 minutes. There is no other way past this screen;
//   3. chatmany calls no AI model (USES_AI = false), so there is no plan screen;
//   4. it starts usage counting: app_opened now, active_session every 30 minutes
//      (POST /api/v1/telemetry).
// Two changes from the reference module: the key is kept encrypted with the OS keychain
// (Electron safeStorage, see keystore.ts) instead of a plain file, and the screens are drawn by
// the app's own window (the gate pushes a GateView; it never shows a dialog).
// The key never leaves the main process.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateView } from "../shared/bridge";
import { OFFLINE_TEXT, UNREACHABLE_TEXT } from "../shared/messages";

export const APP_SLUG = "chatmany";
export const APP_VERSION = "0.1.0";
/** chatmany calls no model: it signs in and counts users, and has no plan screen. */
export const USES_AI = false;
export const PUBLIK_ORIGIN = "https://publikhq.com";

export const POLL_MS = 3_000;
export const POLL_LIMIT_MS = 10 * 60_000;
export const ACTIVE_SESSION_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

const INSTALLS_PATH = "/api/v1/installs";
const WALLET_PATH = "/api/v1/wallet";
const TELEMETRY_PATH = "/api/v1/telemetry";

/** The shape of a publik app token for this app (lib/publik-api/installs/validate.ts on publik). */
const APP_TOKEN = /^pat_chatmany_[a-z0-9]{32}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const SIGN_IN_WAITING = "Waiting for you to sign in in your browser.";
export const SIGN_IN_TIMEOUT = "No sign-in after 10 minutes. Click Sign in with publik to try again.";
export const NO_TOKEN_TEXT = "This copy of chatmany cannot sign in to publik. Download chatmany again from publik.";

/** What this computer keeps between runs. The key is stored encrypted (keystore.ts). */
export interface StoredInstall {
  install_id: string;
  key: string | null;
  claim_url: string | null;
}

export interface InstallStore {
  read(): StoredInstall | null;
  write(value: StoredInstall | null): void;
}

export type PublikOs = "macos" | "windows" | "linux";

export interface GateDeps {
  /** https://publikhq.com, or the local fake publik of the CI smoke test. */
  origin: string;
  /** The app token baked into the build; null in a build without one. */
  appToken: string | null;
  fetch: typeof fetch;
  store: InstallStore;
  /** Opens a page in the system browser. */
  openUrl(url: string): void;
  /** False when this computer has no network at all. */
  isOnline(): boolean;
  device: { os: PublikOs; arch: string | null; name: string | null };
  telemetry: { installId(): string; off(): boolean };
  onChange(view: GateView): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

class NoTokenError extends Error {}

class AnswerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function errorType(body: Json): string | null {
  const e = body.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as Json).type === "string") return (e as Json).type as string;
  return null;
}

function errorMessage(body: Json): string | null {
  const e = body.error;
  if (e && typeof e === "object" && typeof (e as Json).message === "string") return (e as Json).message as string;
  return typeof body.message === "string" ? body.message : null;
}

async function readJson(res: Response): Promise<Json> {
  try {
    const parsed: unknown = await res.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/**
 * The sign-in gate. `start()` runs it; the window draws `current()` and
 * calls `signIn()` and `start()` (Retry). `signedInKey()` is the only way
 * the rest of the app gets the key, and it is null until publik says the
 * install is claimed.
 */
export class PublikGate {
  private view: GateView = { screen: "starting" };
  private key: string | null = null;
  private claimUrl: string | null = null;
  private run = 0;
  private pollHandle: unknown = null;
  private pollUntil = 0;
  private telemetryHandle: unknown = null;
  private openedSent = false;

  constructor(private readonly deps: GateDeps) {}

  current(): GateView {
    return this.view;
  }

  /** The install key, only while publik says this install is signed in. */
  signedInKey(): string | null {
    return this.view.screen === "signed_in" ? this.key : null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private set(view: GateView): void {
    this.view = view;
    this.deps.onChange(view);
  }

  /** Runs (or re-runs, for Retry) the gate from the stored install. */
  async start(): Promise<void> {
    const run = ++this.run;
    this.stopPolling();
    if (this.view.screen !== "sign_in") this.set({ screen: "starting" });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let stored = this.deps.store.read();
        if (!stored?.key) stored = await this.provision(stored);
        if (run !== this.run) return;
        this.key = stored.key;
        this.claimUrl = stored.claim_url;
        const wallet = await this.readWallet(stored.key!);
        if (run !== this.run) return;
        if (wallet.status === 401) {
          // The key was revoked or is unknown: forget it and provision a new install.
          this.forgetKey();
          continue;
        }
        if (wallet.claimState === null) throw new AnswerError(wallet.status, wallet.message ?? UNREACHABLE_TEXT);
        if (wallet.claimUrl) this.claimUrl = wallet.claimUrl;
        if (wallet.claimState === "claimed") {
          this.signedIn(wallet.handle);
          return;
        }
        this.set({ screen: "sign_in", note: null, waiting: false });
        // Polls from the start too: a person who signs in some other way gets through.
        this.startPolling(run);
        return;
      }
      throw new AnswerError(401, UNREACHABLE_TEXT);
    } catch (error) {
      if (run !== this.run) return;
      this.key = null;
      if (error instanceof NoTokenError) {
        this.set({ screen: "no_token", message: NO_TOKEN_TEXT });
        return;
      }
      if (error instanceof AnswerError) {
        // publik answered, with a refusal: its words (they are written for people).
        this.set({ screen: "unreachable", offline: false, message: error.message || UNREACHABLE_TEXT });
        return;
      }
      // Anything else is no answer at all: no network, or publik did not answer.
      const offline = !this.deps.isOnline();
      this.set({ screen: "unreachable", offline, message: offline ? OFFLINE_TEXT : UNREACHABLE_TEXT });
    }
  }

  /** "Sign in with publik": the sign-in page in the system browser, then wait. */
  async signIn(): Promise<void> {
    if (this.view.screen !== "sign_in" || !this.key) return;
    this.deps.openUrl(this.safeClaimUrl());
    this.set({ screen: "sign_in", note: SIGN_IN_WAITING, waiting: true });
    this.startPolling(this.run);
  }

  /**
   * publik refused the key on a chatmany call. "revoked": the key is gone, so
   * the install is provisioned again. "signed_out": the install is no longer
   * linked to an account, so the sign-in screen comes back.
   */
  lost(kind: "revoked" | "signed_out"): void {
    if (this.view.screen !== "signed_in") return;
    this.stopTelemetry();
    if (kind === "revoked") this.forgetKey();
    void this.start();
  }

  /** The claim URL, only when it is a page on publik's own origin. */
  private safeClaimUrl(): string {
    const fallback = `${this.deps.origin}/wallet`;
    if (!this.claimUrl) return fallback;
    try {
      const url = new URL(this.claimUrl);
      return url.origin === new URL(this.deps.origin).origin ? url.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  private forgetKey(): void {
    this.key = null;
    this.deps.store.write(null);
  }

  private signedIn(handle: string | null): void {
    this.stopPolling();
    this.set({ screen: "signed_in", handle });
    this.startTelemetry();
  }

  private startPolling(run: number): void {
    this.stopPolling();
    this.pollUntil = this.now() + POLL_LIMIT_MS;
    const tick = async () => {
      this.pollHandle = null;
      if (run !== this.run || this.view.screen !== "sign_in" || !this.key) return;
      if (this.now() >= this.pollUntil) {
        this.set({ screen: "sign_in", note: SIGN_IN_TIMEOUT, waiting: false });
        return;
      }
      try {
        const wallet = await this.readWallet(this.key);
        if (run !== this.run || this.view.screen !== "sign_in") return;
        if (wallet.status === 401) {
          this.forgetKey();
          void this.start();
          return;
        }
        if (wallet.claimState === "claimed") {
          this.signedIn(wallet.handle);
          return;
        }
      } catch {
        // No answer this time; the next tick asks again.
      }
      this.schedulePoll(tick);
    };
    this.schedulePoll(tick);
  }

  private schedulePoll(tick: () => Promise<void>): void {
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.pollHandle = setTimer(() => void tick(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle === null) return;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.pollHandle);
    this.pollHandle = null;
  }

  /** POST /api/v1/installs: this computer's publik key. */
  private async provision(prior: StoredInstall | null): Promise<StoredInstall> {
    const token = this.deps.appToken?.trim() ?? "";
    if (!APP_TOKEN.test(token)) throw new NoTokenError();
    let installId = prior?.install_id && UUID_V4.test(prior.install_id) ? prior.install_id : randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const { device } = this.deps;
      const res = await this.deps.fetch(`${this.deps.origin}${INSTALLS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          app_token: token,
          app_slug: APP_SLUG,
          app_version: APP_VERSION,
          os: device.os,
          ...(device.arch === "arm64" || device.arch === "x64" ? { arch: device.arch } : {}),
          ...(device.name ? { device_name: device.name.slice(0, 120) } : {}),
          install_id: installId,
          disclosure_version: 1,
        }),
      });
      const body = await readJson(res);
      const key = typeof body.key === "string" && body.key.startsWith("pk_") ? body.key : null;
      if (res.status === 201 && key) {
        const stored: StoredInstall = {
          install_id: typeof body.install_id === "string" && UUID_V4.test(body.install_id) ? body.install_id : installId,
          key,
          claim_url: typeof body.claim_url === "string" ? body.claim_url : null,
        };
        this.deps.store.write(stored); // the key reaches the keychain before anything else sees it
        return stored;
      }
      // 200: this install exists and publik never hands its key out twice; 403: it was disconnected.
      if (res.status === 200 || errorType(body) === "install_revoked") {
        installId = randomUUID();
        continue;
      }
      if (res.status === 401 && errorType(body) === "invalid_app_token") throw new NoTokenError();
      throw new AnswerError(res.status, res.status === 429 ? "publik is busy. Wait a minute, then press Retry." : (errorMessage(body) ?? UNREACHABLE_TEXT));
    }
    throw new AnswerError(500, UNREACHABLE_TEXT);
  }

  /** GET /api/v1/wallet. `claimState` null: publik answered without one (an error). */
  private async readWallet(key: string): Promise<{ status: number; claimState: "anonymous" | "claimed" | null; claimUrl: string | null; handle: string | null; message: string | null }> {
    const res = await this.deps.fetch(`${this.deps.origin}${WALLET_PATH}`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readJson(res);
    const state = body.claim_state === "claimed" || body.claim_state === "anonymous" ? body.claim_state : null;
    const account = body.account && typeof body.account === "object" ? (body.account as Json) : null;
    return {
      status: res.status,
      claimState: res.ok ? state : null,
      claimUrl: typeof body.claim_url === "string" ? body.claim_url : null,
      handle: account && typeof account.handle === "string" ? account.handle : null,
      message: errorMessage(body),
    };
  }

  // ---------- usage counting: publikhq.com/skills/telemetry.md ----------

  private startTelemetry(): void {
    if (!this.openedSent) {
      this.openedSent = true;
      void this.sendEvent("app_opened");
    }
    // Tests pass their own timers and drive time themselves.
    if (this.telemetryHandle !== null || this.deps.setTimer) return;
    const handle = setInterval(() => void this.sendEvent("active_session"), ACTIVE_SESSION_MS);
    handle.unref?.();
    this.telemetryHandle = handle;
  }

  private stopTelemetry(): void {
    if (this.telemetryHandle === null) return;
    clearInterval(this.telemetryHandle as ReturnType<typeof setInterval>);
    this.telemetryHandle = null;
  }

  /** One event, never fails the app, never blocks it. */
  async sendEvent(event: "app_opened" | "active_session"): Promise<number | null> {
    try {
      if (this.deps.telemetry.off()) return null;
      const key = this.signedInKey();
      const { device } = this.deps;
      const res = await this.deps.fetch(`${this.deps.origin}${TELEMETRY_PATH}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          v: 1,
          app: APP_SLUG,
          install_id: this.deps.telemetry.installId(),
          event,
          app_version: APP_VERSION,
          os: device.os,
          ...(device.arch === "arm64" || device.arch === "x64" ? { arch: device.arch } : {}),
        }),
      });
      return res.status;
    } catch {
      return null;
    }
  }
}

/** ~/Library/Application Support/publik, %LOCALAPPDATA%\publik, ~/.config/publik: shared by every publik app. */
export function publikDir(os: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  const base =
    os === "darwin"
      ? join(home, "Library", "Application Support")
      : os === "win32"
        ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(base, "publik");
}

/** DO_NOT_TRACK, PUBLIK_TELEMETRY=0 or a publik consent file with usage:false turn counting off. */
export function usageOff(dir: string, env: NodeJS.ProcessEnv): boolean {
  const dnt = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  if (["0", "false", "off"].includes((env.PUBLIK_TELEMETRY ?? "").trim().toLowerCase())) return true;
  try {
    return (JSON.parse(readFileSync(join(dir, "consent.json"), "utf8")) as { usage?: unknown }).usage === false;
  } catch {
    return false;
  }
}

/** One random UUID per computer account, shared by every publik app, in <publik dir>/telemetry.json (mode 0600). */
export function telemetryInstallId(dir: string): () => string {
  let once: string | null = null;
  const file = join(dir, "telemetry.json");
  const saved = (): string | null => {
    try {
      const id = String((JSON.parse(readFileSync(file, "utf8")) as { install_id?: unknown }).install_id).toLowerCase();
      return UUID_V4.test(id) ? id : null;
    } catch {
      return null;
    }
  };
  return () => {
    if ((once ??= saved())) return once;
    const fresh = randomUUID(); // if the file cannot be saved, this ID lasts for this run only
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ install_id: fresh, created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") })}\n`, { flag: "wx", mode: 0o600 });
      return (once = fresh);
    } catch {
      return (once = saved() ?? fresh); // another publik app saved its ID first
    }
  };
}
