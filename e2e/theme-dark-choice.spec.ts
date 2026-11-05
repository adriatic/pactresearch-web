import { test, expect } from "@playwright/test";
import {
  chooseTheme,
  contrastSweep,
  luminanceOf,
  MIN_CONTRAST,
  pageBackground,
  seedSignedIn,
} from "./themeHelpers";

// Task D11. The dark theme and the Light / Dark / System choice in the
// Account dialog. Before D11 the page was light whatever was saved, so
// the first test fails on that code: the background stays white.

test.setTimeout(60_000);

test("with Dark chosen, the page background is dark and every toolbar label reaches 4.5:1", async ({
  page,
  context,
}) => {
  await seedSignedIn(context, { tag: "theme-dark" });
  await chooseTheme(context, "dark");
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  expect(luminanceOf(await pageBackground(page))).toBeLessThan(0.05);

  const header = await contrastSweep(page.locator("header"));
  const labels = header.map((i) => i.text);
  for (const name of ["New Notebook", "Import", "Account", "Model"]) {
    expect(labels, `toolbar label ${name}`).toContain(name);
  }
  for (const item of header) {
    expect(
      item.ratio,
      `${item.text}: ${item.fg} on ${item.bg}`,
    ).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }

  // The Provider dropdown's arrow is drawn in the dark set's text color.
  const arrow = await page
    .locator("header select.toolbar-select")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(arrow).toContain("d4e0ef");
});

test("a dark choice is applied before any of the app's JavaScript runs (no light flash)", async ({
  page,
  context,
}) => {
  await chooseTheme(context, "dark");
  // Block every script bundle: what is left is the server's HTML, its
  // stylesheet and the inline script in <head>.
  await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, (route) => route.abort());
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(luminanceOf(await pageBackground(page))).toBeLessThan(0.05);

  // And the attribute is there as the body is first parsed: the script
  // sits in <head>, ahead of everything that is drawn.
  const headFirst = await page.evaluate(() => {
    const script = document.head.querySelector("script:not([src])");
    return !!script && /pact-theme/.test(script.textContent ?? "");
  });
  expect(headFirst).toBe(true);
});

test.describe("on a device in dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the Theme choice in Account: Light by default, applies at once, kept after a reload", async ({
    page,
    context,
  }) => {
    await seedSignedIn(context, { tag: "theme-choice" });
    await page.goto("/");
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");

    async function openTheme() {
      await page
        .locator("header")
        .getByRole("button", { name: "Account" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Account" });
      await expect(dialog).toBeVisible();
      return dialog.getByRole("group", { name: "Theme" });
    }

    let theme = await openTheme();
    await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();
    await expect(theme.getByRole("radio")).toHaveCount(3);

    await theme.getByRole("radio", { name: "Dark" }).check();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("pact-theme"))).toBe(
      "dark",
    );
    expect(luminanceOf(await pageBackground(page))).toBeLessThan(0.05);

    await page.reload();
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    await expect(html).toHaveAttribute("data-theme", "dark");
    theme = await openTheme();
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();

    // Light on a dark device stays light (the Task 75 iPad case).
    await theme.getByRole("radio", { name: "Light" }).check();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(luminanceOf(await pageBackground(page))).toBeGreaterThan(0.9);

    // System follows the device, which is dark here.
    await theme.getByRole("radio", { name: "System" }).check();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("pact-theme"))).toBe(
      "system",
    );

    // ...and changes with it.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).toHaveAttribute("data-theme", "light");
  });
});
