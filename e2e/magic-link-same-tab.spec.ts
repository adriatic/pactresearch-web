import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { contrastSweep, MIN_CONTRAST } from "./themeHelpers";

// Task D17j. After a magic-link click the app opens in the tab where the
// email was typed, and the tab the link opened closes itself. Runs in
// chromium and webkit-ipad (playwright.config.ts matches magic-link-*).
//
// "The same browser" is two pages of one browser context (shared cookies,
// shared BroadcastChannel); "a different browser" is a second context.
// The link is the real one from the email Supabase sent, read from the
// local Mailpit; no real email leaves this machine.

const MAILPIT = "http://127.0.0.1:54324";
const NOTE =
  "You are signed in. The app is open in your first tab. You can close this tab.";

const uniqueEmail = (label: string) =>
  `e2e-same-tab-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function messagesTo(email: string): Promise<{ ID: string }[]> {
  const search = await (
    await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    )
  ).json();
  return search.messages ?? [];
}

/**
 * Requests a link from /login in `page` (which then waits) and returns the
 * new-form link of the newest email, once there are more than `before`.
 */
async function requestLink(
  page: Page,
  email: string,
  before = 0,
): Promise<string> {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  let link = "";
  await expect(async () => {
    const messages = await messagesTo(email);
    expect(messages.length).toBeGreaterThan(before);
    const message = await (
      await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`)
    ).json();
    const match = (message.HTML as string).match(/id="confirm" href="([^"]+)"/);
    expect(match).not.toBeNull();
    link = match![1].replace(/&amp;/g, "&");
  }).toPass({ timeout: 15_000 });
  return link;
}

/**
 * A new tab of `context` opened at `url` the way Mail makes Chrome open a
 * link: by the browser itself, not by a script of a page, with nothing in
 * its history before the link. In Chromium that is the DevTools
 * protocol's Target.createTarget; context.newPage() + goto would leave a
 * blank first entry in the history (history.length 2), and Chrome then
 * refuses window.close(). WebKit has no such call, so there the tab is
 * opened with newPage() + goto.
 */
async function openFromOutside(
  context: BrowserContext,
  url: string,
  browserName: string,
): Promise<Page> {
  if (browserName !== "chromium") {
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }
  const helper = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(helper);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const opened = context.waitForEvent("page");
  await cdp.send("Target.createTarget", {
    url,
    browserContextId: targetInfo.browserContextId,
  });
  await cdp.detach();
  const page = await opened;
  await page.waitForLoadState();
  return page;
}

/**
 * Opens the link in a new tab and presses Sign in; returns the tab and its
 * history length on the confirm page (1 in Chromium, as for a tab Mail
 * opens).
 */
async function openLinkAndSignIn(
  context: BrowserContext,
  link: string,
  browserName: string,
): Promise<{ tab: Page; historyAtConfirm: number }> {
  const tab = await openFromOutside(context, link, browserName);
  await expect(tab).toHaveURL(/\/auth\/confirm\?/);
  const historyAtConfirm = await tab.evaluate(() => history.length);
  if (browserName === "chromium") expect(historyAtConfirm).toBe(1);
  await tab.getByRole("button", { name: "Sign in" }).click();
  return { tab, historyAtConfirm };
}

async function expectApp(page: Page) {
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Replaces window.close in every page of `context` with a recorder, so the
 * note can be checked: each call records the history length at that
 * moment. The waiting tab never calls it.
 */
async function recordClose(context: BrowserContext) {
  await context.addInitScript(() => {
    (window as unknown as { __closeCalls: number[] }).__closeCalls = [];
    window.close = () => {
      (window as unknown as { __closeCalls: number[] }).__closeCalls.push(
        history.length,
      );
    };
  });
}
const closeCalls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __closeCalls: number[] }).__closeCalls,
  );

test.setTimeout(90_000);

test("same browser: the first tab becomes the app, the link tab shows the note and asks to close, still with its one history entry", async ({
  context,
  browserName,
}) => {
  await recordClose(context);
  const first = await context.newPage();
  const link = await requestLink(first, uniqueEmail("note"));

  const { tab, historyAtConfirm } = await openLinkAndSignIn(
    context,
    link,
    browserName,
  );

  await expectApp(first);
  await expect(tab.getByRole("status")).toHaveText(NOTE);
  await expect(tab).toHaveURL(/\/auth\/signed-in$/);
  // Sign in and the hand-off added no history entry.
  await expect.poll(() => closeCalls(tab)).toEqual([historyAtConfirm]);

  // Where a browser refuses to close the tab, the note stays: it must fit
  // and read well in light and dark.
  for (const scheme of ["light", "dark"] as const) {
    await tab.emulateMedia({ colorScheme: scheme });
    const items = await contrastSweep(tab.locator("main"));
    const note = items.filter((i) => i.text.includes("You are signed in."));
    expect(note.length, `the note measured (${scheme})`).toBeGreaterThan(0);
    for (const i of note) {
      expect(i.ratio, `${scheme}: ${i.fg} on ${i.bg}`).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    }
    expect(
      await tab.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      `nothing scrolls sideways (${scheme})`,
    ).toBeLessThanOrEqual(0);
    await tab.screenshot({
      path: test.info().outputPath(`note-${scheme}.png`),
    });
  }
});

test("same browser: the link tab really closes, leaving only the first tab, now the app", async ({
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "needs a tab opened by the browser itself (Chromium's Target.createTarget)",
  );
  const first = await context.newPage();
  const link = await requestLink(first, uniqueEmail("close"));

  const { tab } = await openLinkAndSignIn(context, link, browserName);
  await tab.waitForEvent("close", { timeout: 15_000 });

  await expectApp(first);
  expect(context.pages()).toEqual([first]);
});

test("a different browser: no tab answers, so the link tab shows the app as before", async ({
  page,
  browser,
  browserName,
}) => {
  const link = await requestLink(page, uniqueEmail("other"));

  const otherContext = await browser.newContext();
  await recordClose(otherContext);
  const { tab } = await openLinkAndSignIn(otherContext, link, browserName);
  await expectApp(tab);
  expect(await closeCalls(tab)).toEqual([]);
  // The first tab, in the other browser, still waits for its email.
  await expect(page.getByText("Check your email")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await otherContext.close();
});

test("the first tab was closed: the link tab shows the app as before", async ({
  context,
  browserName,
}) => {
  await recordClose(context);
  const first = await context.newPage();
  const link = await requestLink(first, uniqueEmail("gone"));
  // Something must keep the context open in Chromium's helper role.
  const keeper = await context.newPage();
  await first.close();

  const { tab } = await openLinkAndSignIn(context, link, browserName);
  await expectApp(tab);
  expect(await closeCalls(tab)).toEqual([]);
  await expect(keeper).toHaveURL("about:blank");
});

test("two waiting tabs: both become the app, and the link tab closes", async ({
  context,
  browserName,
}) => {
  await recordClose(context);
  const email = uniqueEmail("two");
  const first = await context.newPage();
  await requestLink(first, email);
  // Supabase allows one email to an address per second (max_frequency).
  await first.waitForTimeout(2_000);
  const alsoWaiting = await context.newPage();
  const link = await requestLink(alsoWaiting, email, 1);

  const { tab, historyAtConfirm } = await openLinkAndSignIn(
    context,
    link,
    browserName,
  );

  await expectApp(first);
  await expectApp(alsoWaiting);
  await expect.poll(() => closeCalls(tab)).toEqual([historyAtConfirm]);
});

test("a tab that comes back into view after signing in elsewhere moves to the app", async ({
  context,
}) => {
  // The fallback: the first tab missed the ask (here nobody asks: the
  // sign-in is a separate request), then is shown again.
  const first = await context.newPage();
  const link = await requestLink(first, uniqueEmail("visible"));
  const response = await context.request.get(link);
  expect(new URL(response.url()).pathname).toBe("/auth/confirm");
  const html = await response.text();
  const tokenHash = html.match(/name="token_hash" value="([^"]+)"/)![1];
  const signedIn = await context.request.post("/auth/confirm/verify", {
    headers: { origin: "http://localhost:3000", accept: "application/json" },
    form: { token_hash: tokenHash, type: "email" },
  });
  expect(await signedIn.json()).toEqual({ location: "/auth/signed-in" });

  await first.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expectApp(first);
});

test("signing out and in again works the same way each time", async ({
  context,
  browserName,
}) => {
  await recordClose(context);
  const email = uniqueEmail("again");
  const first = await context.newPage();
  for (let round = 0; round < 2; round++) {
    if (round > 0) await first.waitForTimeout(2_000);
    const link = await requestLink(first, email, round);
    const { tab, historyAtConfirm } = await openLinkAndSignIn(
      context,
      link,
      browserName,
    );
    await expectApp(first);
    await expect(tab.getByRole("status")).toHaveText(NOTE);
    await expect.poll(() => closeCalls(tab)).toEqual([historyAtConfirm]);
    await tab.close();

    await first
      .locator("header")
      .getByRole("button", { name: "Account" })
      .click();
    await first
      .getByRole("dialog", { name: "Account" })
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(first).toHaveURL(/\/login$/);
  }
});

test("the Sign in button's JSON answer: a bad link still goes to the sign-in page's message, and other sites are still refused", async ({
  request,
}) => {
  const bad = await request.post("/auth/confirm/verify", {
    headers: { origin: "http://localhost:3000", accept: "application/json" },
    form: { token_hash: "pkce_not_a_real_token", type: "email" },
  });
  expect(bad.status()).toBe(200);
  const { location } = await bad.json();
  expect(location).toMatch(/^\/login\?error=(link_expired|link_failed)$/);

  const evil = await request.post("/auth/confirm/verify", {
    headers: { origin: "https://evil.example", accept: "application/json" },
    form: { token_hash: "pkce_anything", type: "email" },
  });
  expect(evil.status()).toBe(403);
});
