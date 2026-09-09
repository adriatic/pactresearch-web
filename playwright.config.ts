import { defineConfig, devices } from "@playwright/test";

// Runs against the real dev server + real local Supabase (Docker) — same
// local-only instance every integration test already uses, per
// .env.local. Not for CI use yet; this is the first E2E test in the repo,
// added specifically to verify the notebook-delete lock check (0fbc8c6)
// through the real UI rather than just the route directly.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
