import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    // Integration tests need local Supabase (Docker) running; keep them out
    // of the default fast unit-test run. See `npm run test:integration`.
    exclude: [...configDefaults.exclude, "__tests__/integration/**"],
  },
});
