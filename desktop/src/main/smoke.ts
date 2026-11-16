import { BrowserWindow, nativeTheme, type NativeImage } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PublikGate } from "./publik";

/**
 * The CI smoke test, run inside the BUILT app (`--smoke-test=<folder>`).
 *
 * It proves three things on a clean computer and writes them to
 * <folder>/result.json, with a screenshot and the screen's text:
 *   1. the first screen is the sign-in gate (or, with no publik, the
 *      "not reachable" screen with Retry; or, with no app token, the
 *      "cannot sign in" screen);
 *   2. there is no way past the gate without a key: every workspace call
 *      from the window is refused, the window has no Node, cannot open a
 *      window or navigate away, a changed address shows the same gate, and
 *      the window never sees a key;
 *   3. (expect=sign_in) Sign in with publik opens publik's claim page in the
 *      system browser, and once publik says the install is claimed the app
 *      shows Connect Instagram; then the connect, "I cancelled, start again",
 *      and a tour of the workspace (see workspaceTour), with screenshots.
 *
 * Only a fake publik on 127.0.0.1 is ever called (scripts/smoke.mjs runs it):
 * the flag never points the app at a real server, and it cannot open the
 * gate, it only watches it.
 */
export type SmokeExpect = "sign_in" | "unreachable" | "no_token";

export interface SmokeConfig {
  outDir: string;
  origin: string;
  appToken: string | null;
  expect: SmokeExpect;
}

const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

/** The smoke flags, or null for a normal start. Throws when the flag is there but the rest is not right. */
export function parseSmokeFlags(argv: readonly string[], env: Record<string, string | undefined>): SmokeConfig | null {
  const flag = argv.find((arg) => arg.startsWith("--smoke-test="));
  if (!flag) return null;
  const outDir = flag.slice("--smoke-test=".length);
  if (!outDir) throw new Error("--smoke-test needs a folder");
  const origin = env.CHATMANY_SMOKE_ORIGIN ?? "";
  if (!LOCAL_ORIGIN.test(origin)) throw new Error("CHATMANY_SMOKE_ORIGIN must be http://127.0.0.1:<port>");
  const expect = env.CHATMANY_SMOKE_EXPECT ?? "sign_in";
  if (expect !== "sign_in" && expect !== "unreachable" && expect !== "no_token") throw new Error("CHATMANY_SMOKE_EXPECT must be sign_in, unreachable or no_token");
  const token = env.CHATMANY_SMOKE_APP_TOKEN?.trim() || null;
  return { outDir, origin, appToken: token, expect };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      if (await test()) return true;
    } catch {
      /* not ready yet */
    }
    await delay(250);
  }
  return false;
}

/** What the window can reach, asked from inside the window. */
const PROBE = `(async () => {
  const bridge = window.chatmany;
  const out = {
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    bridgeKeys: Object.keys(bridge || {}).sort(),
    workspaceKeys: Object.keys((bridge && bridge.workspace) || {}).sort(),
  };
  out.status = await bridge.workspace.status();
  out.statusWithConnect = await bridge.workspace.status("abcdefgh12345678");
  out.api = await bridge.workspace.api("campaigns");
  out.apiPost = await bridge.workspace.api("campaigns/delete", { method: "POST", body: { campaign_id: "x" } });
  out.connect = await bridge.workspace.connect();
  out.reopen = await bridge.workspace.reopenConnect();
  out.disconnect = await bridge.workspace.disconnect();
  out.exportCsv = await bridge.workspace.exportCsv(null);
  const view = await bridge.gate.get();
  out.gateView = view;
  out.gateHasKey = JSON.stringify(view).includes("pk_");
  out.storage = JSON.stringify(Object.assign({}, window.localStorage)).includes("pk_");
  location.hash = "#/workspace";
  await new Promise((r) => setTimeout(r, 600));
  out.screenAfterHash = document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? null;
  out.windowOpen = window.open("https://example.com/") === null;
  out.text = document.body.innerText;
  return out;
})()`;

export async function runSmoke(ctx: { win: BrowserWindow; gate: PublikGate; config: SmokeConfig; opened: string[]; appUrlPrefix: string }): Promise<number> {
  const { win, gate, config, opened, appUrlPrefix } = ctx;
  const checks: Check[] = [];
  const check = (name: string, ok: unknown, detail?: unknown) => checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  mkdirSync(config.outDir, { recursive: true });

  let lastPaint: NativeImage | null = null;
  win.webContents.on("paint", (_event, _dirty, image) => {
    lastPaint = image;
  });
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const screen = () => js<string>(`document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? ""`);
  const capture = async (name: string) => {
    win.webContents.invalidate();
    await delay(400);
    let image = await win.webContents.capturePage();
    if (image.isEmpty() && lastPaint) image = lastPaint;
    writeFileSync(join(config.outDir, `${name}.png`), image.toPNG());
    return !image.isEmpty();
  };
  const noKey = (text: string) => !/pk_(live|test)_/.test(text);
  /** The same screen with the system in dark mode: the page follows prefers-color-scheme. */
  const captureDark = async (name: string) => {
    nativeTheme.themeSource = "dark";
    try {
      let background = "";
      const followed = await waitFor(async () => {
        const media = await js<boolean>(`matchMedia("(prefers-color-scheme: dark)").matches`);
        background = await js<string>("getComputedStyle(document.body).backgroundColor");
        const rgb = (background.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        return media && rgb.length === 3 && rgb.every((v) => v < 80);
      }, 5_000);
      return { followed, background, shot: await capture(`${name}-dark`) };
    } finally {
      nativeTheme.themeSource = "system";
      await delay(200);
    }
  };

  try {
    await waitFor(() => !win.webContents.isLoading(), 30_000);
    const wanted = config.expect;
    const reached = await waitFor(async () => (await screen()) === wanted, 40_000);
    const firstScreen = await screen();
    check(`the first screen is "${wanted}"`, reached, firstScreen);
    const text = await js<string>("document.body.innerText");
    writeFileSync(join(config.outDir, `${wanted}.txt`), text);
    check("a screenshot of the first screen was taken", await capture(wanted));
    const dark = await captureDark(wanted);
    check("in dark mode the screen turns dark", dark.followed, dark.background);
    check("a dark mode screenshot was taken", dark.shot);
    check("the screen text holds no key", noKey(text));

    if (wanted === "sign_in") {
      check('the screen says "Sign in with publik"', text.includes("Sign in with publik"));
      check("the screen has the Sign in with publik button", await js<boolean>(`Boolean(document.querySelector("[data-gate-signin]"))`));
    } else if (wanted === "unreachable") {
      check('the screen says "publik is not reachable"', text.includes("publik is not reachable"));
      check("the screen has a Retry button", await js<boolean>(`Boolean(document.querySelector("[data-gate-retry]"))`));
    } else {
      check("the screen says this copy cannot sign in", text.includes("cannot sign in"));
    }

    // No way past the gate without a key.
    const probe = await js<Record<string, unknown>>(PROBE);
    const refused = (value: unknown) => Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
    const notSignedIn = (value: unknown) => refused(value) && (value as { error?: unknown }).error === "not_signed_in";
    check("the window has no Node (require, process, module)", probe.require === "undefined" && probe.process === "undefined" && probe.module === "undefined", { require: probe.require, process: probe.process, module: probe.module });
    check("the bridge offers only the listed calls", JSON.stringify(probe.bridgeKeys) === JSON.stringify(["gate", "info", "openExternal", "workspace"]), probe.bridgeKeys);
    check("status is refused before sign-in", notSignedIn(probe.status), probe.status);
    check("status with a connect id is refused before sign-in", notSignedIn(probe.statusWithConnect), probe.statusWithConnect);
    check("a workspace read is refused before sign-in", notSignedIn(probe.api), probe.api);
    check("a workspace write is refused before sign-in", notSignedIn(probe.apiPost), probe.apiPost);
    check("Connect Instagram is refused before sign-in", notSignedIn(probe.connect), probe.connect);
    check("reopening a connect link is refused before sign-in", probe.reopen === false, probe.reopen);
    check("Disconnect is refused before sign-in", notSignedIn(probe.disconnect), probe.disconnect);
    check("the CSV download is refused before sign-in", refused(probe.exportCsv), probe.exportCsv);
    check("the gate view the window gets holds no key", probe.gateHasKey === false && probe.storage === false);
    check("a changed address shows the same gate", probe.screenAfterHash === wanted, probe.screenAfterHash);
    check("the window cannot open another window", probe.windowOpen === true && BrowserWindow.getAllWindows().length === 1);
    check("nothing was opened in the browser before Sign in was pressed", opened.length === 0, opened);

    await js(`location.href = "https://example.com/"; true`).catch(() => undefined);
    await delay(800);
    check("the window cannot navigate away", win.webContents.getURL().startsWith(appUrlPrefix), win.webContents.getURL());
    check("the main process gives out no key before sign-in", gate.signedInKey() === null);

    if (wanted === "sign_in") {
      await js(`document.querySelector("[data-gate-signin]").click(); true`);
      const asked = await waitFor(() => opened.length > 0, 10_000);
      const claimUrl = opened[0] ?? "";
      check("Sign in with publik opens publik's claim page in the system browser", asked && claimUrl.startsWith(`${config.origin}/claim/`), claimUrl);
      // A slow machine (x64 under Rosetta) may draw the note a moment after the browser opened.
      check("the gate says it is waiting for the browser", await waitFor(async () => (await js<string>("document.body.innerText")).includes("Waiting for you to sign in"), 5_000));
      // The person signs in: the fake publik marks the install claimed when its claim page is opened.
      if (claimUrl) await fetch(claimUrl).catch(() => undefined);
      const passed = await waitFor(async () => (await screen()) === "connect", 30_000);
      check("after sign-in the app shows Connect Instagram", passed, await screen());
      const after = await js<string>("document.body.innerText");
      writeFileSync(join(config.outDir, "connect.txt"), after);
      check("a screenshot after sign-in was taken", await capture("connect"));
      const darkConnect = await captureDark("connect");
      check("in dark mode the screen after sign-in turns dark", darkConnect.followed && darkConnect.shot, darkConnect.background);
      check("the Connect Instagram button is there", after.includes("Connect Instagram"));
      check("the screen after sign-in holds no key", noKey(after));
      check("the main process holds the key only after sign-in", gate.signedInKey() !== null);

      // Connect Instagram: the consent page opens in the system browser. The person cancels
      // there (Instagram does not tell publik), presses "I cancelled, start again", then approves.
      const before = opened.length;
      await js(`document.querySelector("[data-connect-button]").click(); true`);
      const waiting = await waitFor(async () => opened.length > before && (await screen()) === "connecting", 15_000);
      const first = opened[before] ?? "";
      check("Connect Instagram opens Instagram's consent page in the system browser", waiting && first.startsWith("https://www.instagram.com/oauth/authorize"), first);
      check("while it waits, the app offers I cancelled, start again", await js<boolean>(`Boolean(document.querySelector("[data-connect-restart]"))`));
      writeFileSync(join(config.outDir, "connecting.txt"), await js<string>("document.body.innerText"));
      check("a screenshot of the wait was taken", await capture("connecting"));
      await js(`document.querySelector("[data-connect-restart]").click(); true`);
      const restarted = await waitFor(async () => opened.length > before + 1 && (await screen()) === "connecting", 15_000);
      const second = opened[before + 1] ?? "";
      check("I cancelled, start again opens a new Instagram link at once", restarted && second.startsWith("https://www.instagram.com/oauth/authorize") && second !== first, second);
      await fetch(`${config.origin}/fake/instagram-approved`).catch(() => undefined);
      const connected = await waitFor(async () => (await screen()) === "workspace", 20_000);
      check("after Instagram, the app shows the workspace", connected, await screen());
      await workspaceTour({ js, capture, captureDark, check, win, outDir: config.outDir, noKey });
    }
  } catch (error) {
    check("the smoke run finished", false, error instanceof Error ? error.message : String(error));
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  writeFileSync(join(config.outDir, "result.json"), `${JSON.stringify({ expect: config.expect, ok, checks }, null, 2)}\n`);
  return ok ? 0 : 1;
}

type Js = <T>(code: string) => Promise<T>;
type Capture = (name: string) => Promise<boolean>;
type CaptureDark = (name: string) => Promise<{ followed: boolean; background: string; shot: boolean }>;

/**
 * The connected workspace, as the person goes through it: the Automations
 * tab (three numbers, the paused notice), New automation (post grid,
 * preview, Save in view, Cancel asks first), People (CSV), Account (usage in
 * percent, Disconnect asks first and Keep it connected sends nothing), then
 * all three tabs at the 390 px minimum width. Light and dark screenshots.
 */
async function workspaceTour(ctx: {
  js: Js;
  capture: Capture;
  captureDark: CaptureDark;
  check: (name: string, ok: unknown, detail?: unknown) => void;
  win: BrowserWindow;
  outDir: string;
  noKey: (text: string) => boolean;
}): Promise<void> {
  const { js, capture, captureDark, check, win, outDir, noKey } = ctx;
  const has = (selector: string) => js<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const count = (selector: string) => js<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const click = (selector: string) => js(`(document.querySelector(${JSON.stringify(selector)})?.click(), true)`);
  const text = () => js<string>("document.body.innerText");
  const texts: string[] = [];
  const shoot = async (name: string, what: string) => {
    check(`a screenshot of ${what} was taken`, await capture(name));
    const dark = await captureDark(name);
    check(`in dark mode ${what} turns dark`, dark.followed && dark.shot, dark.background);
  };
  const tab = async (name: string, ready: string) => {
    await click(`[data-tab="${name}"]`);
    return waitFor(() => has(ready), 10_000);
  };

  // Automations: the numbers loaded, the list loaded (empty: one sentence, one action).
  await waitFor(async () => (await count("[data-summary-tile]")) === 3 && !(await has("[data-summary-tile] [data-slot=skeleton]")) && (await has("[data-new-automation]")), 15_000);
  await delay(800);
  const ws = await text();
  texts.push(ws);
  writeFileSync(join(outDir, "workspace.txt"), ws);
  check("an empty balance shows the paused notice", ws.includes("Replies are paused") && (await has("[data-chatmany-no-balance]")));
  check("the workspace shows the last 30 days in three numbers", (await count("[data-summary-tile]")) === 3);
  check("the workspace has the tabs Automations, People and Account", (await has('[data-tab="automations"]')) && (await has('[data-tab="people"]')) && (await has('[data-tab="account"]')));
  await shoot("workspace", "the workspace");

  // New automation.
  await click("[data-new-automation]");
  check("New automation opens the builder with the post grid", await waitFor(async () => (await has("[data-builder]")) && (await has('[data-post-picker] [role="radio"]')), 10_000));
  await click('[data-post-picker] [role="radio"]');
  check("picking a post marks it", await waitFor(() => has('[data-post-picker] [role="radio"][aria-checked="true"]'), 3_000));
  check("the builder shows what the commenter gets", await has("[data-preview]"));
  const saveInView = await js<number[] | null>(`(() => { const r = document.querySelector("[data-save]")?.getBoundingClientRect(); return r ? [Math.round(r.top), Math.round(r.bottom), innerHeight] : null; })()`);
  check("Save is in view without scrolling", Boolean(saveInView && saveInView[0]! >= 0 && saveInView[1]! <= saveInView[2]!), saveInView);
  texts.push(await text());
  await delay(300);
  await shoot("builder", "the builder");
  await click("[data-builder-cancel]");
  check("Cancel after a change asks in the page first", await waitFor(() => has("[data-close-confirm]"), 5_000));
  check("a screenshot of that question was taken", await capture("builder-close"));
  await click("[data-close-discard]");
  check("Close without saving goes back to the list", await waitFor(async () => !(await has("[data-builder]")) && (await has("[data-new-automation]")), 5_000));

  // People.
  check("the People tab opens, with the CSV download", await tab("people", "[data-export]"));
  await waitFor(async () => !(await has("[data-contacts] [data-slot=skeleton]")), 5_000);
  await delay(400);
  texts.push(await text());
  await shoot("people", "People");

  // Account.
  check("the Account tab opens", await tab("account", "[data-chatmany-usage]"));
  await delay(400);
  const account = await text();
  texts.push(account);
  writeFileSync(join(outDir, "account.txt"), account);
  check("Account shows What chatmany uses, in percent, with the bar", account.includes("What chatmany uses") && /\d+%/.test(account) && (await has("[data-usage-bar]")));
  await shoot("account", "Account");
  await click("[data-disconnect-button]");
  check("Disconnect asks in the page first", await waitFor(() => has("[data-disconnect-confirm]"), 5_000));
  check("a screenshot of the Disconnect question was taken", await capture("disconnect"));
  await click("[data-disconnect-keep]");
  check("Keep it connected closes the question", await waitFor(async () => !(await has("[data-disconnect-confirm]")), 5_000));

  const all = texts.join("\n");
  check("the workspace shows no money amount", !/[$€£]\s?\d/.test(all), all.match(/[$€£]\s?\d[\d.,]*/)?.[0]);
  check("the workspace text holds no key", noKey(all));

  // The 390 px minimum width: every tab fits, nothing scrolls sideways.
  const [width, height] = win.getSize();
  win.setSize(390, 820);
  await delay(700);
  for (const [name, ready] of [
    ["automations", "[data-new-automation]"],
    ["people", "[data-export]"],
    ["account", "[data-chatmany-usage]"],
  ] as const) {
    await tab(name, ready);
    await delay(400);
    const size = await js<number[]>("[document.documentElement.scrollWidth, window.innerWidth]");
    check(`at 390 px wide, ${name} does not scroll sideways`, size[0]! <= size[1]! + 1, size);
    check(`a 390 px screenshot of ${name} was taken`, await capture(`narrow-${name}`));
  }
  win.setSize(width ?? 1100, height ?? 820);
}

