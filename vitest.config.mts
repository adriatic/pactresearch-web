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
    // e2e/** and e2e-prod/** are Playwright's own *.spec.ts suites (see
    // `npm run test:e2e` and `npm run test:e2e:prod`) — vitest's default
    // include pattern would otherwise also match those files and try to
    // run them itself.
    exclude: [
      ...configDefaults.exclude,
      "__tests__/integration/**",
      "e2e/**",
      "e2e-prod/**",
    ],
  },
});
