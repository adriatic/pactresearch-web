import { defineConfig, devices } from "@playwright/test";

// Deliberately separate from the root playwright.config.ts / `npm run
// test:e2e`. Specs here hit real PRODUCTION (pact-web.pactresearch.net)
// authenticated as a dedicated, disposable test account -- they must never
// run as part of the default local-dev E2E suite. Invoke explicitly:
// `npm run test:e2e:prod`.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "https://pact-web.pactresearch.net",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
