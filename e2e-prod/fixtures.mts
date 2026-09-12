/**
 * fixtures.mts
 *
 * Playwright fixture that spins up a browser context already authenticated
 * against PRODUCTION as the dedicated test account. Import `test`/`expect`
 * from here (instead of "@playwright/test") in any spec under this
 * directory that needs a real, logged-in production browser session.
 *
 * These specs are deliberately NOT part of the local-dev E2E suite (see
 * e2e-prod/playwright.config.ts) -- run them explicitly with
 * `npm run test:e2e:prod`.
 */

import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { getProdAuthCookies, PROD_BASE_URL } from "./prod-session.mts";

export const test = base.extend<{
  prodContext: BrowserContext;
  prodPage: Page;
}>({
  prodContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: PROD_BASE_URL });

    const cookies = await getProdAuthCookies();
    const domain = new URL(PROD_BASE_URL).hostname;
    await context.addCookies(
      cookies.map(({ name, value }) => ({
        name,
        value,
        domain,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      })),
    );

    // Playwright's fixture `use` callback, not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(context);
    await context.close();
  },

  prodPage: async ({ prodContext }, use) => {
    const page = await prodContext.newPage();
    // Playwright's fixture `use` callback, not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
    await page.close();
  },
});

export { expect };
