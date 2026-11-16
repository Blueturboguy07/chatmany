// Bundles the main process and the preload into dist-electron/ as CommonJS.
// The preload runs sandboxed, where it can load no file of its own, so it is one file.
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main/main.ts", preload: "src/preload/preload.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
