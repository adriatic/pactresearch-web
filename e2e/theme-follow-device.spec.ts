import { test, expect, type Page } from "@playwright/test";
import {
  contrastSweep,
  expectPageTheme,
  MIN_CONTRAST,
  seedSignedIn,
} from "./themeHelpers";

// Task D11g (Nik, 2026-11-05). pact-web has no theme setting of its own:
// the page is dark when the device is dark, light when it is light, and
// follows the device when it changes. Nothing is saved in the browser or
// with the account; a pact-theme value left in storage by an earlier D11
// build has no effect.

test.setTimeout(60_000);

async function openWorkspace(page: Page) {
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
}

/** Leaves a value in storage before any page script runs, as a D11 build would have. */
async function leaveOldChoice(page: Page, value: string) {
  await page.context().addInitScript((v) => {
    window.localStorage.setItem("pact-theme", v);
  }, value);
}

test.describe("on a light device", () => {
  test.use({ colorScheme: "light" });

  test("the page is light", async ({ page, context }) => {
    await seedSignedIn(context, { tag: "follow-light" });
    await openWorkspace(page);
    await expectPageTheme(page, "light");
    // The Provider dropdown's arrow in the light --text-strong (#333).
    const arrow = await page
      .locator("header select.toolbar-select")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(arrow).toContain("%23333");
  });

  test("a pact-theme value of dark left in storage does nothing", async ({
    page,
    context,
  }) => {
    await seedSignedIn(context, { tag: "follow-old-dark" });
    await leaveOldChoice(page, "dark");
    await openWorkspace(page);
    await expectPageTheme(page, "light");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });
});

test.describe("on a dark device", () => {
  test.use({ colorScheme: "dark" });

  test("the page is dark and every toolbar label reaches 4.5:1", async ({
    page,
    context,
  }) => {
    await seedSignedIn(context, { tag: "follow-dark" });
    await openWorkspace(page);
    await expectPageTheme(page, "dark");

    const header = await contrastSweep(page.locator("header"));
    expect(header.map((i) => i.text)).toContain("Provider:");
    for (const item of header) {
      expect(
        item.ratio,
        `${item.text}: ${item.fg} on ${item.bg}`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
    // The Provider dropdown's arrow in the dark --text-strong (#d4e0ef).
    const arrow = await page
      .locator("header select.toolbar-select")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(arrow).toContain("d4e0ef");
  });

  test("a pact-theme value of light left in storage does nothing", async ({
    page,
    context,
  }) => {
    await seedSignedIn(context, { tag: "follow-old-light" });
    await leaveOldChoice(page, "light");
    await openWorkspace(page);
    await expectPageTheme(page, "dark");
  });

  test("dark before any of the app's JavaScript runs (no white flash)", async ({
    page,
  }) => {
    // Every script bundle blocked: what is left is the server's HTML and
    // the stylesheet, which alone must make the page dark.
    await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, (route) =>
      route.abort(),
    );
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expectPageTheme(page, "dark");
  });
});

test("a change of the device's setting changes the page at once, without a reload", async ({
  page,
  context,
}) => {
  await seedSignedIn(context, { tag: "follow-live" });
  await page.emulateMedia({ colorScheme: "light" });
  await openWorkspace(page);
  await expectPageTheme(page, "light");
  // A marker that a reload or a navigation would wipe.
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await expectPageTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectPageTheme(page, "light");

  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __sameDocument?: boolean }).__sameDocument ===
        true,
    ),
  ).toBe(true);
});

test("the Account dialog has no Theme group, and nothing writes pact-theme", async ({
  page,
  context,
}) => {
  await seedSignedIn(context, { tag: "follow-account" });
  await openWorkspace(page);
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();
  // The Profile tab, where D11 had the Theme group.
  await expect(dialog.getByRole("tab", { name: "Profile" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const profile = dialog.getByRole("tabpanel", { name: "Profile" });
  await expect(profile.getByLabel("Your name:")).toBeVisible();
  await expect(profile.getByRole("group", { name: "Theme" })).toHaveCount(0);
  await expect(profile.getByRole("radio")).toHaveCount(0);
  await expect(dialog.getByText("Theme", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("pact-theme"))).toBe(
    null,
  );
});
