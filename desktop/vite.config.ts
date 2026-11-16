import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** The window's page: src/renderer → dist/renderer, loaded by the main process from app://chatmany/. */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [tailwindcss()],
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: false,
    // One CSS file and no inline module preload polyfill: the page's CSP allows no inline script.
    modulePreload: false,
    rollupOptions: {
      onwarn(warning, warn) {
        // Radix marks its files "use client" for server rendering; a desktop page has none, so the mark means nothing here.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
