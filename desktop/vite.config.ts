import { defineConfig } from "vite";

/** The window's page: src/renderer → dist/renderer, loaded by the main process from app://chatmany/. */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: false,
    // One CSS file and no inline module preload polyfill: the page's CSP allows no inline code.
    modulePreload: false,
  },
});
