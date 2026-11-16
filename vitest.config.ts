import { configDefaults, defineConfig } from "vitest/config";

// The Worker's tests. The desktop app (desktop/) has its own dependencies and its own Vitest config.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "desktop/**"],
  },
});
