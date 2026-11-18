// Bundles the main process and the preload into dist-electron/ as CommonJS.
// The preload runs sandboxed, where it can load no file of its own, so it is one file.
// The updater (publik-updater.cjs, publik-update-verify.cjs) is bundled into main.cjs; electron-updater
// and blakejs stay outside: they are the app's only runtime dependencies (package.json "dependencies"),
// and electron-builder packs them into app.asar's node_modules.
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main/main.ts", preload: "src/preload/preload.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater", "blakejs"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
