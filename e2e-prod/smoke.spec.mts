/**
 * smoke.spec.mts
 *
 * Confirms the production test-session helper actually authenticates
 * against the real deployed app, not a mock -- a real GET /api/notebooks
 * for the dedicated test account, using its real, non-elevated,
 * RLS-scoped session.
 *
 * Deliberately not part of `npm run test:e2e` -- run explicitly with
 * `npm run test:e2e:prod`.
 */

import { prodFetch } from "./prod-session.mts";
import { test, expect } from "./fixtures.mts";

test("prodFetch returns an authenticated, non-401 response for the test account's own notebooks", async () => {
  const response = await prodFetch("/api/notebooks");
  expect(response.status).not.toBe(401);
  expect(response.ok).toBe(true);

  const notebooks = await response.json();
  expect(Array.isArray(notebooks)).toBe(true);
});

test("prodContext fixture loads the real app as a logged-in user, not an anonymous one", async ({
  prodPage,
}) => {
  await prodPage.goto("/");
  await expect(prodPage).not.toHaveURL(/login|sign-in/i);
});
