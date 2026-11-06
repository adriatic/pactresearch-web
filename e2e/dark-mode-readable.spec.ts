import { test, expect, type Page } from "@playwright/test";
import {
  expectPageTheme,
  MIN_CONTRAST,
  seedSignedIn,
  type DeviceScheme,
} from "./themeHelpers";

// Task 75 follow-up, rewritten for Task D11 and again for D11g.
//
// The original bug: on Nik's iPad, set to dark mode, every toolbar
// button looked greyed out -- a dark block left over from the Create Next
// App template turned body text near-white while the buttons kept a light
// background. Task 75 locked the page to light. D11 added a full dark set;
// since D11g the page simply follows the device, with no setting in the
// app. So this spec checks a light and a dark device: the page is the
// device's scheme throughout (background and native controls), and every
// toolbar label reaches 4.5:1 against the button it is drawn on.

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

for (const device of ["light", "dark"] as DeviceScheme[]) {
  test.describe(`device ${device}`, () => {
    test.use({ colorScheme: device });

    test(`the page is ${device} and the toolbar labels stay readable`, async ({
      page,
      context,
    }) => {
      await seedSignedIn(context, { tag: "dark-mode" });

      await page.goto("/");
      await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
      await expectPageTheme(page, device);

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
