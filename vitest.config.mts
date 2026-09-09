import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests need local Supabase (Docker) running; keep them out
    // of the default fast unit-test run. See `npm run test:integration`.
    // e2e/** is Playwright's own *.spec.ts suite (see `npm run test:e2e`) —
    // vitest's default include pattern would otherwise also match those
    // files and try to run them itself.
    exclude: [...configDefaults.exclude, "__tests__/integration/**", "e2e/**"],
  },
});
