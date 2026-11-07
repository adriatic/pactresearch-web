import { test, expect } from "@playwright/test";
import { openComparison, seedCompare } from "./compareHelpers";
import {
  compareButton,
  meaningNote,
  saveMockKey,
  startMockAnthropic,
  type MockAnthropic,
} from "./meaningHelpers";

// Task D15. The Meaning engine on the iPad profile (the file name puts it
// in the webkit-ipad project only), against the local stand-in for
// Anthropic. The note, the button and the findings fit the screen, and
// the page never scrolls sideways.

test.setTimeout(120_000);

let mock: MockAnthropic;

test.beforeAll(async ({}, workerInfo) => {
  mock = await startMockAnthropic(54560 + workerInfo.workerIndex);
});
test.afterAll(async () => {
  await mock.close();
});

const noSidewaysScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test("Meaning on the iPad: note, Compare and findings, and no sideways scroll", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "meaning-ipad");
  await saveMockKey(page, mock.key);
  await openComparison(page, seed.answers[0], seed.answers[3], "meaning");
  await expect(meaningNote(page)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  await compareButton(page).tap();
  const findings = page
    .getByRole("region", { name: "Comparison" })
    .locator("[data-compare-finding]");
  await expect(findings).toHaveCount(4, { timeout: 15_000 });
  await expect(page.locator("[data-meaning-usage]")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  const viewport = page.viewportSize()!;
  for (const box of await findings.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  )) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
  }
  expect(mock.calls()).toBe(1);
});
