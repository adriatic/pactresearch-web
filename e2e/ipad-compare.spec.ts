import { test, expect } from "@playwright/test";
import { openComparison, seedCompare, TEXT } from "./compareHelpers";

// Task D13. The Compare page on the iPad profile (the file name puts it
// in the webkit-ipad project only). Side by side
// must fit the screen: each panel scrolls inside itself, and the page
// never scrolls sideways.

test.setTimeout(90_000);

test("the Compare page opens on the iPad, and side by side fits the screen", async ({
  page,
  context,
}) => {
  // Long answers with very long unbroken words, so a panel has to wrap
  // and scroll.
  const longWord = "x".repeat(400);
  const a = (TEXT.first + ` ${longWord}\n`).repeat(40);
  const b = (TEXT.fourth + ` ${longWord}\n`).repeat(40);
  const seed = await seedCompare(context, "compare-ipad", [
    a,
    b,
    TEXT.json,
    TEXT.fourth,
  ]);
  await openComparison(page, seed.answers[0], seed.answers[1]);
  const comparison = page.getByRole("region", { name: "Comparison" });
  await expect(comparison.locator(".diff-added").first()).toBeVisible();

  await comparison.getByRole("tab", { name: "Side by side" }).click();
  const panels = comparison.locator("[data-compare-panel]");
  await expect(panels).toHaveCount(2);

  const viewport = page.viewportSize()!;
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const panels = [...document.querySelectorAll("[data-compare-panel]")].map(
      (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          scrollsInside: el.scrollHeight > el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
          widerThanItself: el.scrollWidth > el.clientWidth + 1,
        };
      },
    );
    return {
      pageScrollWidth: root.scrollWidth,
      pageClientWidth: root.clientWidth,
      panels,
    };
  });
  // No horizontal page scroll.
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.pageClientWidth);
  for (const panel of layout.panels) {
    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(panel.right).toBeLessThanOrEqual(viewport.width);
    // The panel scrolls inside itself, up and down only.
    expect(panel.overflowY).toBe("auto");
    expect(panel.scrollsInside).toBe(true);
    expect(panel.widerThanItself).toBe(false);
  }
  // The two panels sit side by side.
  expect(layout.panels[1].left).toBeGreaterThan(layout.panels[0].left);
});
