import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, hostname, platform, tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { startUpdates, type PublikUpdates } from "../../publik-updater.cjs";
import { CHANNELS, allowedApiPath, type GateView } from "../shared/bridge";
import { ChatmanyClient, NOT_SIGNED_IN } from "./chatmany";
import { keychainStore } from "./keystore";
import { PUBLIK_ORIGIN, PublikGate, publikDir, telemetryInstallId, usageOff, type PublikOs } from "./publik";
import { parseSmokeFlags, runSmoke, type SmokeConfig } from "./smoke";
import { isOpenableUrl } from "./urls";

/**
 * chatmany's main process. The window is a client of publik: it shows the
 * sign-in gate until publik says this install is signed in, then the
 * workspace. Every network call is made here, with the key from the OS
 * keychain; the window never sees the key.
 *
 * Window rules: context isolation on, Node integration off, sandbox on; the
 * page is served from app://chatmany/ with a strict CSP; it may not open
 * windows, navigate away, embed web views or ask for permissions. Links
 * open in the system browser, and only publik's and Instagram's.
 */

const SCHEME = "app";
const APP_HOST = "chatmany";
const APP_URL = `${SCHEME}://${APP_HOST}/index.html`;
const RENDERER_DIR = join(__dirname, "..", "dist", "renderer");

/**
 * The page's rules. Scripts come only from the app itself. Styles may also be
 * inline: the dialogs (Radix) and the toasts (Sonner) add their own <style>
 * elements. Instagram serves profile pictures and post previews from the two
 * image hosts.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function readSmokeFlags(): SmokeConfig | null {
  try {
    return parseSmokeFlags(process.argv, process.env);
  } catch (error) {
    process.stderr.write(`chatmany smoke test: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  }
}

const smoke = readSmokeFlags();

if (smoke) {
  // A clean computer every time: no stored key, a mock keychain, and no GPU.
  app.setPath("userData", mkdtempSync(join(tmpdir(), "chatmany-smoke-")));
  app.commandLine.appendSwitch("use-mock-keychain");
  app.disableHardwareAcceleration();
  // A smoke run that hangs fails instead of holding the CI job.
  setTimeout(() => app.exit(4), 150_000).unref();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const ORIGIN = smoke ? smoke.origin : PUBLIK_ORIGIN;
const OS: PublikOs = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";

let win: BrowserWindow | null = null;
let lastConnectUrl: string | null = null;
/** A test build running the CI update proof (publik-updater.cjs): no window, no publik, nothing else. */
let updaterTestRun = false;
/** Smoke test: the pages the app asked the system browser to open, instead of opening them. */
const opened: string[] = [];

function openInBrowser(url: string): void {
  if (smoke) {
    opened.push(url);
    return;
  }
  void shell.openExternal(url);
}

/** The app token: the packaged build carries it in package.json (`publik.appToken`, set by CI). */
function appToken(): string | null {
  if (smoke) return smoke.appToken;
  if (!app.isPackaged && process.env.PUBLIK_APP_TOKEN) return process.env.PUBLIK_APP_TOKEN.trim();
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { publik?: { appToken?: unknown } };
    return typeof pkg.publik?.appToken === "string" ? pkg.publik.appToken : null;
  } catch {
    return null;
  }
}

const sharedDir = () => (smoke ? join(app.getPath("userData"), "publik") : publikDir(platform(), homedir(), process.env));

const gate = new PublikGate({
  origin: ORIGIN,
  appToken: appToken(),
  fetch: (input, init) => net.fetch(input as string, init),
  store: keychainStore(join(app.getPath("userData"), "publik-install.json"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (sealed) => safeStorage.decryptString(sealed),
  }),
  openUrl: openInBrowser,
  isOnline: () => net.isOnline(),
  device: { os: OS, arch: arch(), name: hostname() || null },
  telemetry: { installId: () => telemetryInstallId(sharedDir())(), off: () => usageOff(sharedDir(), process.env) },
  onChange: (view: GateView) => {
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.gateChanged, view);
  },
});

const client = new ChatmanyClient({
  origin: ORIGIN,
  fetch: (input, init) => net.fetch(input as string, init),
  key: () => gate.signedInKey(),
  isOnline: () => net.isOnline(),
  onAuthLost: (kind) => gate.lost(kind),
});

/** Only the app's own page may call the main process. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(win && event.sender === win.webContents && frame && frame.url.startsWith(`${SCHEME}://${APP_HOST}/`));
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>, refused: R): void {
  ipcMain.handle(channel, async (event, ...args) => (fromApp(event) ? fn(...(args as A)) : refused));
}

/** Workspace calls wait behind the gate: nothing reaches publik's chatmany routes before sign-in. */
function signedIn(): boolean {
  return gate.current().screen === "signed_in" && gate.signedInKey() !== null;
}

function registerIpc(): void {
  handle(CHANNELS.gateGet, () => gate.current(), { screen: "starting" } as GateView);
  handle(CHANNELS.gateSignIn, () => gate.signIn(), undefined);
  handle(CHANNELS.gateRetry, () => gate.start(), undefined);

  handle(CHANNELS.status, (connectId: unknown) => (signedIn() ? client.status(typeof connectId === "string" ? connectId : undefined) : NOT_SIGNED_IN), NOT_SIGNED_IN);

  handle(
    CHANNELS.connect,
    async () => {
      if (!signedIn()) return NOT_SIGNED_IN;
      const res = await client.connectUrl();
      if (!res.ok) return res;
      lastConnectUrl = res.data.url;
      // Instagram's consent page opens in the system browser, never inside the app.
      openInBrowser(res.data.url);
      return { ok: true as const, data: { connect_id: res.data.connect_id, expires_at: res.data.expires_at } };
    },
    NOT_SIGNED_IN,
  );

  handle(
    CHANNELS.reopenConnect,
    () => {
      if (!signedIn() || !lastConnectUrl) return false;
      openInBrowser(lastConnectUrl);
      return true;
    },
    false,
  );

  handle(CHANNELS.disconnect, () => (signedIn() ? client.disconnect() : NOT_SIGNED_IN), NOT_SIGNED_IN);

  handle(
    CHANNELS.api,
    (path: unknown, init: unknown) => {
      if (!signedIn()) return NOT_SIGNED_IN;
      const opts = init && typeof init === "object" ? (init as { method?: unknown; body?: unknown }) : {};
      const allowed = allowedApiPath(path, opts.method);
      if (!allowed) return { ok: false as const, status: 404, error: "not_found", message: "chatmany cannot do that." };
      return client.api(allowed.path, allowed.query, (opts.method as "GET" | "POST" | undefined) ?? "GET", opts.body);
    },
    NOT_SIGNED_IN,
  );

  handle(
    CHANNELS.exportCsv,
    async (campaignId: unknown) => {
      if (!signedIn()) return { ok: false as const, message: NOT_SIGNED_IN.message };
      const res = await client.exportCsv(typeof campaignId === "string" && campaignId ? campaignId : null);
      if (!res.ok) return { ok: false as const, message: res.message };
      if (!win) return { ok: false as const, message: "chatmany could not save the file." };
      const pick = await dialog.showSaveDialog(win, {
        title: "Save the people list",
        defaultPath: join(app.getPath("downloads"), "chatmany-people.csv"),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (pick.canceled || !pick.filePath) return { ok: true as const, saved: false };
      try {
        writeFileSync(pick.filePath, res.data, { encoding: "utf8" });
        return { ok: true as const, saved: true };
      } catch {
        return { ok: false as const, message: "chatmany could not save the file there. Pick another folder." };
      }
    },
    { ok: false as const, message: "Refused." },
  );

  handle(
    CHANNELS.openExternal,
    (url: unknown) => {
      if (!isOpenableUrl(url, ORIGIN)) return false;
      openInBrowser(url);
      return true;
    },
    false,
  );
}

function serveRenderer(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = normalize(join(RENDERER_DIR, relative));
    if (!file.startsWith(RENDERER_DIR + sep)) return new Response("Not found", { status: 404 });
    try {
      const body = readFileSync(file);
      return new Response(body, {
        headers: {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": CSP,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  // chatmany needs no camera, microphone, location, notifications or anything else.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    title: "chatmany",
    width: 1100,
    height: 820,
    // The layout works down to a phone-wide 390 px.
    minWidth: 390,
    minHeight: 560,
    // macOS: no title bar; the page's own header is the drag area, the window buttons sit in it.
    ...(platform() === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    // Windows: the only menu is Help › Check for Updates…; it stays hidden until the Alt key shows it.
    autoHideMenuBar: true,
    show: false,
    backgroundColor: dark ? "#0a0a0a" : "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      // The CI smoke test renders without a screen.
      offscreen: Boolean(smoke),
    },
  });

  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isOpenableUrl(url, ORIGIN)) openInBrowser(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!url.startsWith(`${SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());

  if (!smoke) window.once("ready-to-show", () => window.show());
  void window.loadURL(APP_URL);
  return window;
}

/** "Check for Updates…" (publik-updater.cjs): macOS in the chatmany menu, Windows in Help (Alt shows it). */
function appMenu(updates: PublikUpdates | null): void {
  if (platform() !== "darwin") {
    Menu.setApplicationMenu(updates && platform() === "win32" ? Menu.buildFromTemplate([{ role: "help", submenu: [updates.menuItem()] }]) : null);
    return;
  }
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: "about" },
    ...(updates ? [{ type: "separator" as const }, updates.menuItem()] : []),
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit" },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: "appMenu", submenu: appSubmenu }, { role: "editMenu" }, { role: "viewMenu", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] }, { role: "windowMenu" }]),
  );
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("window-all-closed", () => {
  if (platform() !== "darwin" || smoke) app.quit();
});

app.on("activate", () => {
  if (!smoke && !updaterTestRun && BrowserWindow.getAllWindows().length === 0) win = createWindow();
});

void app.whenReady().then(async () => {
  // Updates (publik-updater.cjs, docs/updates.md): publik's signed feed for chatmany-mann, checked at
  // launch, every 24 hours and from "Check for Updates…"; the download runs in the background, then
  // the app asks to restart. A test build started with PUBLIK_UPDATER_TEST runs the CI update proof and
  // exits: nothing below starts (no window, no publik, no Instagram). The smoke test checks no updates:
  // it may talk only to its fake publik.
  const updates = smoke ? null : startUpdates({ slug: "chatmany-mann", appName: "chatmany", menu: false });
  if (updates?.testHook) {
    updaterTestRun = true;
    return;
  }

  nativeTheme.themeSource = "system";
  serveRenderer();
  lockDownSession();
  registerIpc();
  appMenu(updates);
  win = createWindow();
  void gate.start();

  if (smoke && win) {
    const code = await runSmoke({ win, gate, config: smoke, opened, appUrlPrefix: `${SCHEME}://${APP_HOST}/` });
    app.exit(code);
  }
});
