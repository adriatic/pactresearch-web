import { test, expect, type Page } from "@playwright/test";
import {
  chooseTheme,
  luminanceOf,
  MIN_CONTRAST,
  pageBackground,
  seedSignedIn,
  type ThemeChoice,
} from "./themeHelpers";

// Task 75 follow-up, rewritten for Task D11.
//
// The original bug: on Nik's iPad, set to dark mode, every toolbar
// button looked greyed out -- a dark block left over from the Create Next
// App template turned body text near-white while the buttons kept a light
// background. Task 75 locked the page to light. D11 adds a real dark
// theme as a CHOICE (Account, Theme: Light, Dark, System), so this spec
// now checks each combination of the device's setting and that choice:
// the page is the theme it should be, and every toolbar label reaches
// 4.5:1 against the button it is drawn on. Since Task D11f nothing chosen
// is System.

test.setTimeout(60_000);

async function toolbarContrasts(page: Page) {
  return page.evaluate(() => {
    function luminance(rgb: string) {
      const [r, g, b] = rgb
        .match(/\d+(\.\d+)?/g)!
        .slice(0, 3)
        .map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    return [...document.querySelectorAll("header button")].map((el) => {
      const style = getComputedStyle(el);
      const a = luminance(style.color);
      const b = luminance(style.backgroundColor);
      return {
        label: el.textContent,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });
}

const CASES: {
  device: "light" | "dark";
  choice: ThemeChoice | null;
  expected: "light" | "dark";
}[] = [
  // Task D11f: nothing chosen means System, so the page follows the
  // device. On the Task 75 iPad (dark mode) that is now the whole dark
  // set, never the old mix of light buttons and near-white text.
  { device: "light", choice: null, expected: "light" },
  { device: "dark", choice: null, expected: "dark" },
  { device: "dark", choice: "light", expected: "light" },
  { device: "light", choice: "dark", expected: "dark" },
  { device: "dark", choice: "system", expected: "dark" },
  { device: "light", choice: "system", expected: "light" },
];

for (const { device, choice, expected } of CASES) {
  test.describe(`device ${device}, choice ${choice ?? "none"}`, () => {
    test.use({ colorScheme: device });

    test(`the page is ${expected} and the toolbar labels stay readable`, async ({
      page,
      context,
    }) => {
      await seedSignedIn(context, { tag: "dark-mode" });
      if (choice) await chooseTheme(context, choice);

      await page.goto("/");
      await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        expected,
      );
      const background = luminanceOf(await pageBackground(page));
      if (expected === "light") expect(background).toBeGreaterThan(0.9);
      else expect(background).toBeLessThan(0.05);
      // Native controls follow the page, not the device.
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      ).toBe(expected);

      const contrasts = await toolbarContrasts(page);
      expect(contrasts.map((c) => c.label)).toEqual([
        "New Notebook",
        "Run",
        "Import",
        "Settings",
        "Account",
        "Model",
      ]);
      for (const { label, ratio } of contrasts) {
        expect(ratio, `${label} label contrast`).toBeGreaterThanOrEqual(
          MIN_CONTRAST,
        );
      }
    });
  });
}
