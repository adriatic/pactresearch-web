import { defineConfig, devices } from "@playwright/test";

// Deliberately separate from the root playwright.config.ts / `npm run
// test:e2e`. Specs here hit a real DEPLOYMENT authenticated as a
// dedicated, disposable test account -- they must never run as part of
// the default local-dev E2E suite. Invoke explicitly:
// `npm run test:e2e:prod`.
//
// Target defaults to production and is overridable, so the same specs
// can run against a protected Preview deployment:
//
//   PACT_E2E_BASE_URL=https://pactresearch-xxxx.vercel.app \
//     npm run test:e2e:prod
//
// WHY THIS FILE DUPLICATES A FEW LINES OF prod-session.mts INSTEAD OF
// IMPORTING THEM. Playwright loads this config through a different
// module path than it loads the specs. Any module imported by BOTH
// ends up instantiated twice -- once CJS for the config, once ESM for
// the specs -- and the second load fails with "does not provide an
// export named ...". Confirmed twice while wiring this up: first with
// a shared target.mts, then with prod-session.mts itself, which broke
// even its own long-standing PROD_BASE_URL export the moment this file
// imported it. So the config stays self-contained. The duplication is
// the default URL string and an env read; prod-session.mts holds the
// same values for everything the specs actually use.
const PRODUCTION_BASE_URL = "https://pact-web.pactresearch.net";
const baseURL = process.env.PACT_E2E_BASE_URL || PRODUCTION_BASE_URL;
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

// Fails fast on the one combination that produces a baffling failure:
// aiming at a protected deployment with no secret. Without this the
// specs run against Vercel's SSO login page and report missing
// selectors, which reads as an application bug rather than a missing
// environment variable. Production is exempt -- it is public, so the
// secret stays optional for anyone who has not set one up.
if (baseURL !== PRODUCTION_BASE_URL && !bypassSecret) {
  throw new Error(
    `PACT_E2E_BASE_URL is set to ${baseURL}, which is not production, but ` +
      "VERCEL_AUTOMATION_BYPASS_SECRET is not set. Vercel Deployment " +
      "Protection will serve its SSO page instead of the app. Generate a " +
      "secret under Vercel → project Settings → Deployment Protection → " +
      "Protection Bypass for Automation, and export it as " +
      "VERCEL_AUTOMATION_BYPASS_SECRET.",
  );
}

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    // Reaches Playwright's own built-in page/request fixtures only. The
    // prodPage fixture builds its context by hand, so fixtures.mts
    // applies these too -- wiring only this file would look correct and
    // leave every authenticated spec hitting the SSO page.
    ...(bypassSecret
      ? {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": bypassSecret,
            "x-vercel-set-bypass-cookie": "true",
          },
        }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
