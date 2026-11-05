import { test, expect } from "@playwright/test";
import {
  chooseTheme,
  contrastSweep,
  luminanceOf,
  MIN_CONTRAST,
  pageBackground,
  seedSignedIn,
} from "./themeHelpers";

// Task D11a. The dark values and the Light / Dark / System choice in the
// Account dialog. Before D11a the page was light whatever was saved, so
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

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(luminanceOf(await pageBackground(page))).toBeLessThan(0.05);

  // Each toolbar button's label against its own button color, disabled
  // ones included (Run is disabled with no discussion open), the same
  // measure as dark-mode-readable.spec.ts.
  const buttons = await page.locator("header button").evaluateAll((els) =>
    els.map((el) => {
      const lum = (rgb: string) => {
        const [r, g, b] = rgb
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((v) => {
            const c = Number(v) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const s = getComputedStyle(el);
      const [hi, lo] = [lum(s.color), lum(s.backgroundColor)].sort(
        (a, b) => b - a,
      );
      return { label: el.textContent, ratio: (hi + 0.05) / (lo + 0.05) };
    }),
  );
  expect(buttons.map((b) => b.label)).toEqual([
    "New Notebook",
    "Run",
    "Import",
    "Settings",
    "Account",
    "Model",
  ]);
  for (const { label, ratio } of buttons) {
    expect(ratio, `${label} label contrast`).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
  }

  // And every other piece of text in the top bar ("PACT", "Provider:",
  // the dropdown), against what it is really drawn on.
  const header = await contrastSweep(page.locator("header"));
  expect(header.map((i) => i.text)).toContain("Provider:");
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

test.describe("with the browser asking for dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the choice survives a reload, and Light stays light", async ({
    page,
    context,
  }) => {
    await seedSignedIn(context, { tag: "theme-choice" });
    await page.goto("/");
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    const html = page.locator("html");

    // Nothing chosen: light, although the browser asks for dark (the
    // Task 75 iPad case).
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(luminanceOf(await pageBackground(page))).toBeGreaterThan(0.9);

    async function themeGroup() {
      await page
        .locator("header")
        .getByRole("button", { name: "Account" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Account" });
      await expect(dialog).toBeVisible();
      return dialog.getByRole("group", { name: "Theme" });
    }

    let theme = await themeGroup();
    await expect(theme.getByRole("radio")).toHaveCount(3);
    await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();

    // Dark: applied at once, saved under pact-theme, kept after a reload.
    await theme.getByRole("radio", { name: "Dark" }).check();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("pact-theme"))).toBe(
      "dark",
    );
    await page.reload();
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(luminanceOf(await pageBackground(page))).toBeLessThan(0.05);
    theme = await themeGroup();
    await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();

    // Light, chosen on a browser that asks for dark: light, and still
    // light after a reload. Native controls follow the page.
    await theme.getByRole("radio", { name: "Light" }).check();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.reload();
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(luminanceOf(await pageBackground(page))).toBeGreaterThan(0.9);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      ),
    ).toBe("light");

    // System follows the browser, which asks for dark here.
    theme = await themeGroup();
    await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();
    await theme.getByRole("radio", { name: "System" }).check();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).toHaveAttribute("data-theme", "light");
  });
});
