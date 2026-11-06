import { test, expect, type Page } from "@playwright/test";
import {
  contrastSweep,
  expectPageTheme,
  MIN_CONTRAST,
  type ContrastItem,
} from "./themeHelpers";
import { openComparison, SEMANTIC, seedCompare, TEXT } from "./compareHelpers";

// Task D13. Every mark, pill, count and piece of text on the Compare page
// reaches 4.5:1 against what it is drawn on, on a light and on a dark
// device (the page follows the device; there is no theme setting). Each
// state is swept: word marks inline and side by side, JSON findings with
// the amber count and the not-JSON error, semantic findings with the
// other pills, the too-long message and "Response not found".

test.setTimeout(120_000);

function expectReadable(items: ContrastItem[], where: string) {
  expect(items.length, `${where}: something was measured`).toBeGreaterThan(0);
  const below = items.filter((i) => i.ratio < MIN_CONTRAST);
  expect(
    below.map((i) => `${where}: "${i.text}" ${i.fg} on ${i.bg} = ${i.ratio}`),
  ).toEqual([]);
}

const sweep = (page: Page) => contrastSweep(page.locator("main"));

for (const scheme of ["light", "dark"] as const) {
  test(`contrast sweep of the Compare page on a ${scheme} device`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const long = (TEXT.first + "\n").repeat(60);
    const longOther = (TEXT.fourth + "\n").repeat(60);
    const seed = await seedCompare(context, `compare-sweep-${scheme}`, [
      TEXT.first,
      TEXT.fourth,
      TEXT.json,
      SEMANTIC.a,
      SEMANTIC.b,
      long,
      longOther,
    ]);
    const [first, fourth, json, semA, semB, longA, longB, otherJson] =
      seed.answers;
    const comparison = page.getByRole("region", { name: "Comparison" });

    // Word diff, inline: added and removed marks, green and red counts.
    await openComparison(page, first, fourth);
    await expectPageTheme(page, scheme);
    await expect(comparison.locator(".diff-added").first()).toBeVisible();
    await expect(comparison.locator(".diff-removed").first()).toBeVisible();
    const inline = await sweep(page);
    for (const needed of [TEXT.first.split(" ")[0], "words matched"]) {
      expect(
        inline.some((i) => i.text.includes(needed)),
        `measured: ${needed}`,
      ).toBe(true);
    }
    expectReadable(inline, "word inline");

    // Side by side.
    await comparison.getByRole("tab", { name: "Side by side" }).click();
    await expect(comparison.locator("[data-compare-panel]")).toHaveCount(2);
    expectReadable(await sweep(page), "word side by side");

    // JSON findings: conflict pills and the amber "changed" count.
    await openComparison(page, json, otherJson, "json");
    await expect(comparison.locator(".finding-pill-conflict")).toHaveCount(3);
    await expect(comparison.locator(".diff-count-amber")).toBeVisible();
    expectReadable(await sweep(page), "json findings");

    // JSON on text that is not JSON: the error.
    await openComparison(page, first, otherJson, "json");
    await expect(comparison.locator("[data-compare-error]")).toBeVisible();
    expectReadable(await sweep(page), "json error");

    // Semantic: agreement, uncertain and unique pills.
    await openComparison(page, semA, semB, "semantic");
    await expect(comparison.locator(".finding-pill-agreement")).toHaveCount(1);
    await expect(comparison.locator(".finding-pill-uncertain")).toHaveCount(1);
    await expect(comparison.locator(".finding-pill-unique")).toHaveCount(2);
    expectReadable(await sweep(page), "semantic findings");

    // Character diff over the cap: the message.
    await openComparison(page, longA, longB, "character");
    await expect(comparison.locator("[data-compare-too-long]")).toBeVisible();
    expectReadable(await sweep(page), "too long");

    // Response not found.
    await page.goto(`/compare?a=${first}&b=${seed.strangerAnswer}`);
    await expect(page.locator('[data-compare-not-found="B"]')).toBeVisible({
      timeout: 15_000,
    });
    expectReadable(await sweep(page), "not found");
  });
}

test.describe("on a dark device", () => {
  test.use({ colorScheme: "dark" });

  test("the Compare page is dark before any of the app's JavaScript runs (no white flash)", async ({
    page,
    context,
  }) => {
    const seed = await seedCompare(context, "compare-flash");
    await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, (route) =>
      route.abort(),
    );
    await page.goto(`/compare?a=${seed.answers[0]}&b=${seed.answers[3]}`, {
      waitUntil: "domcontentloaded",
    });
    await expectPageTheme(page, "dark");
    // The server's HTML already carries the marks, in the dark set.
    const added = await page
      .locator(".diff-added")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(added).toBe("rgb(24, 76, 55)"); // --diff-added-bg #184c37
  });
});

test("the Compare page follows a live change of the device's setting, without a reload", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-live");
  await page.emulateMedia({ colorScheme: "light" });
  await openComparison(page, seed.answers[0], seed.answers[3]);
  await expectPageTheme(page, "light");
  const mark = page.locator(".diff-added").first();
  const background = () =>
    mark.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await background()).toBe("rgb(220, 252, 231)"); // #dcfce7
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await expectPageTheme(page, "dark");
  expect(await background()).toBe("rgb(24, 76, 55)"); // #184c37
  await page.emulateMedia({ colorScheme: "light" });
  await expectPageTheme(page, "light");
  expect(await background()).toBe("rgb(220, 252, 231)");

  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __sameDocument?: boolean }).__sameDocument ===
        true,
    ),
  ).toBe(true);
});
