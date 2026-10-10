import { test, expect, type Page } from "@playwright/test";

// Task 72 follow-up 2. PostHog must not start on the sign-in pages
// (/login, /auth/confirm): /auth/confirm carries the one-time sign-in token
// in its address and a hidden field. After signing in it must start as
// usual, and the page it starts on must not see the token as its referrer.
// Runs in chromium and webkit-ipad (playwright.config.ts).
//
// instrumentation-client.ts never starts PostHog in an automated browser,
// so navigator.webdriver is set to false here: these pages then behave as
// in a person's browser. Every PostHog request is stopped before it leaves
// this machine and only counted.

const MAILPIT = "http://127.0.0.1:54324";

const uniqueEmail = () =>
  `e2e-ph-signin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function asPerson(page: Page): Promise<string[]> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => false,
    });
  });
  const posthogRequests: string[] = [];
  await page.route(/posthog\.com/, (route) => {
    posthogRequests.push(route.request().url());
    return route.abort();
  });
  return posthogRequests;
}

async function linkFromEmail(email: string): Promise<string> {
  let link = "";
  await expect(async () => {
    const search = await (
      await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      )
    ).json();
    expect(search.messages?.length).toBeGreaterThan(0);
    const message = await (
      await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)
    ).json();
    const match = (message.HTML as string).match(/id="confirm" href="([^"]+)"/);
    expect(match).not.toBeNull();
    link = match![1].replace(/&amp;/g, "&");
  }).toPass({ timeout: 15_000 });
  return link;
}

test.setTimeout(60_000);

test("PostHog stays off on /login and /auth/confirm, and starts after sign-in without the token", async ({
  page,
}) => {
  const posthogRequests = await asPerson(page);
  const email = uniqueEmail();

  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(posthogRequests).toEqual([]);

  const link = await linkFromEmail(email);
  await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/confirm\?token_hash=/);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "origin",
  );
  await page.waitForTimeout(2_000);
  expect(posthogRequests).toEqual([]);

  // The Sign in button still works with the "origin" referrer policy (the
  // verify route needs a real Origin header).
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });

  // Control: on the workspace PostHog does start, so the silence above is
  // the sign-in switch, not PostHog failing to load.
  await expect.poll(() => posthogRequests.length).toBeGreaterThan(0);
  const referrer = await page.evaluate(() => document.referrer);
  expect(referrer).not.toContain("token_hash");
  expect(referrer).not.toContain("/auth/confirm");
  for (const url of posthogRequests) expect(url).not.toContain("token_hash");
});
