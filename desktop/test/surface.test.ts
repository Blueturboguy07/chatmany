import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keychainStore } from "../src/main/keystore";
import { parseSmokeFlags } from "../src/main/smoke";
import { isOpenableUrl } from "../src/main/urls";
import { CHANNELS, allowedApiPath } from "../src/shared/bridge";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? files(path) : [path];
  });
}

/** Code without comments, the way publik's scan reads it (lib/scan/telemetry-check.ts there). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("publik's scan", () => {
  it("finds the publik module: installs, telemetry and app_opened in one file, with the slug as a literal", () => {
    const module = code(read("src/main/publik.ts"));
    expect(module).toContain('"/api/v1/installs"');
    expect(module).toContain('"/api/v1/telemetry"');
    expect(module).toContain('"app_opened"');
    expect(module).toMatch(/APP_SLUG = "chatmany"/);
  });
});

describe("the window's door to the main process", () => {
  it("the preload uses exactly the channel names of shared/bridge.ts", () => {
    const preload = read("src/preload/preload.ts");
    const used = [...new Set([...preload.matchAll(/"((?:gate|workspace|app):[a-z-]+)"/g)].map((m) => m[1]))].sort();
    expect(used).toEqual(Object.values(CHANNELS).sort());
  });

  it("the window is isolated, sandboxed and without Node", () => {
    const main = read("src/main/main.ts");
    expect(main).toMatch(/contextIsolation: true/);
    expect(main).toMatch(/nodeIntegration: false/);
    expect(main).toMatch(/sandbox: true/);
    expect(main).toMatch(/minWidth: 390/);
    expect(main).toMatch(/setWindowOpenHandler/);
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/setPermissionRequestHandler/);
  });

  it("passes only the workspace paths publik's proxy allows", () => {
    expect(allowedApiPath("campaigns", "GET")).toEqual({ path: "campaigns", query: "" });
    expect(allowedApiPath("campaigns", "POST")).toEqual({ path: "campaigns", query: "" });
    expect(allowedApiPath("dashboard?days=30&campaign_id=a", undefined)).toEqual({ path: "dashboard", query: "days=30&campaign_id=a" });
    expect(allowedApiPath("campaigns/delete", "GET")).toBeNull();
    expect(allowedApiPath("contacts/export", "GET")).toBeNull();
    expect(allowedApiPath("../hosted/tenants", "GET")).toBeNull();
    expect(allowedApiPath("status?tenant=t_1", "GET")).toBeNull();
    expect(allowedApiPath("constructor", "GET")).toBeNull();
    expect(allowedApiPath("media", "DELETE")).toBeNull();
    expect(allowedApiPath(42, "GET")).toBeNull();
  });

  it("opens only publik and Instagram pages in the browser", () => {
    expect(isOpenableUrl("https://publikhq.com/privacy#chatmany", "https://publikhq.com")).toBe(true);
    expect(isOpenableUrl("https://www.instagram.com/p/abc/", "https://publikhq.com")).toBe(true);
    expect(isOpenableUrl("http://publikhq.com/", "https://publikhq.com")).toBe(false);
    expect(isOpenableUrl("https://publikhq.com.evil.example/", "https://publikhq.com")).toBe(false);
    expect(isOpenableUrl("file:///etc/passwd", "https://publikhq.com")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)", "https://publikhq.com")).toBe(false);
  });
});

describe("the key on disk", () => {
  it("is sealed by the OS keychain, never in clear text, and gone after a reset", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "chatmany-test-")), "publik-install.json");
    const cipher = { available: () => true, encrypt: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString("hex")}`), decrypt: (b: Buffer) => Buffer.from(b.toString().slice(7), "hex").toString() };
    const store = keychainStore(file, cipher);
    store.write({ install_id: "3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f", key: "pk_live_secret_value", claim_url: null });
    expect(readFileSync(file, "utf8")).not.toContain("pk_live_secret_value");
    expect(store.read()?.key).toBe("pk_live_secret_value");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const broken = keychainStore(file, { ...cipher, decrypt: () => { throw new Error("keychain changed"); } });
    expect(broken.read()).toEqual({ install_id: "3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f", key: null, claim_url: null });
    store.write(null);
    expect(store.read()).toBeNull();
  });

  it("stays in memory only when the system cannot encrypt", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "chatmany-test-")), "publik-install.json");
    const store = keychainStore(file, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    store.write({ install_id: "3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f", key: "pk_live_secret_value", claim_url: null });
    expect(readFileSync(file, "utf8")).not.toContain("pk_live");
    expect(store.read()?.key).toBe("pk_live_secret_value");
    expect(keychainStore(file, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" }).read()?.key).toBeNull();
  });
});

describe("the smoke flag", () => {
  it("is off without the flag, and only ever points at this computer", () => {
    expect(parseSmokeFlags(["chatmany"], {})).toBeNull();
    expect(parseSmokeFlags(["chatmany", "--smoke-test=/tmp/out"], { CHATMANY_SMOKE_ORIGIN: "http://127.0.0.1:4100" })).toEqual({ outDir: "/tmp/out", origin: "http://127.0.0.1:4100", appToken: null, expect: "sign_in" });
    expect(() => parseSmokeFlags(["chatmany", "--smoke-test=/tmp/out"], { CHATMANY_SMOKE_ORIGIN: "https://publikhq.com" })).toThrow();
    expect(() => parseSmokeFlags(["chatmany", "--smoke-test=/tmp/out"], { CHATMANY_SMOKE_ORIGIN: "http://127.0.0.1.evil.example:80" })).toThrow();
    expect(() => parseSmokeFlags(["chatmany", "--smoke-test=/tmp/out"], {})).toThrow();
  });
});

describe("the words in the app", () => {
  const sources = [...files("src/renderer"), ...files("src/shared"), "src/main/publik.ts", "src/main/chatmany.ts"].filter((f) => /\.(tsx?|html)$/.test(f));

  it("show no dollar amounts", () => {
    for (const file of sources) expect(code(read(file)), file).not.toMatch(/\$\s?\d|\bUSD\b|balance_micros\s*\/|toFixed\(2\)/);
  });

  it("use no browser dialogs", () => {
    for (const file of sources) expect(code(read(file)), file).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\(/);
  });

  it("name no other company's app but Instagram", () => {
    for (const file of sources.filter((f) => f.startsWith("src/renderer") || f.startsWith("src/shared"))) {
      expect(code(read(file)), file).not.toMatch(/\b(Meta|Facebook|ManyChat|WhatsApp|Messenger|TikTok)\b/);
    }
  });
});
