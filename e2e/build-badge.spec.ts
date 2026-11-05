import { test, expect } from "@playwright/test";
import {
  chooseTheme,
  contrastSweep,
  luminanceOf,
  MIN_CONTRAST,
  pageBackground,
} from "./themeHelpers";

// The build badge is rendered from the root layout, so it must be on
// every page -- including the login screen, which is the whole point:
// a deployed build has to be identifiable WITHOUT credentials, or a
// Preview deploy cannot be checked at all.
//
// No seeding, no session. That is deliberate: this spec must exercise
// the unauthenticated path, because that is the path used to verify
// real deployments.

test("the build badge is present before signing in, and is selectable text", async ({
  page,
}) => {
  await page.goto("/login");

  const badge = page.locator("[data-build-label]");
  await expect(badge).toBeVisible();

  // Locally there is no VERCEL_ENV, so it must say so plainly rather
  // than inventing an environment or a commit.
  await expect(badge).toHaveText(/^Local/);
  await expect(badge).toHaveAttribute("title", /build/i);

  // Whatever it says, it must never be an empty or placeholder-looking
  // string -- the failure mode the task called out.
  const text = (await badge.innerText()).trim();
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/undefined|null|\{\{|%%/i);
});

test("the badge does not cover the sign-in controls", async ({ page }) => {
  await page.goto("/login");

  const badge = page.locator("[data-build-label]");
  const emailField = page.getByPlaceholder("your@email.com");
  await expect(badge).toBeVisible();
  await expect(emailField).toBeVisible();

  const badgeBox = await badge.boundingBox();
  const fieldBox = await emailField.boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(fieldBox).not.toBeNull();

  // "Unobtrusive" as an assertion rather than an intention: the badge
  // must not overlap the thing the page exists for.
  const overlaps =
    badgeBox!.x < fieldBox!.x + fieldBox!.width &&
    badgeBox!.x + badgeBox!.width > fieldBox!.x &&
    badgeBox!.y < fieldBox!.y + fieldBox!.height &&
    badgeBox!.y + badgeBox!.height > fieldBox!.y;
  expect(overlaps).toBe(false);

  // Still usable with the badge on screen.
  await emailField.fill("someone@example.com");
  await expect(emailField).toHaveValue("someone@example.com");
});

// Task 73. Readable at a glance: at least the usual 4.5:1 contrast for
// small text, measured as the browser draws it, opacity included. Task
// D11: in both themes, against the real page background (the badge is
// translucent, so what shows through it is the page, which is no longer
// always white).
for (const theme of ["light", "dark"] as const) {
  test(`the badge is readable in the ${theme} theme: contrast at least 4.5 to 1 against its background`, async ({
    page,
    context,
  }) => {
    await chooseTheme(context, theme);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const badge = page.locator("[data-build-label]");
    await expect(badge).toBeVisible();
    const [item] = await contrastSweep(badge);
    expect(item.text).toMatch(/^Local/);
    expect(item.ratio, `${item.fg} on ${item.bg}`).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
    // The page behind it really is the theme's.
    const page_ = luminanceOf(await pageBackground(page));
    if (theme === "light") expect(page_).toBeGreaterThan(0.9);
    else expect(page_).toBeLessThan(0.05);
    await expect(badge).toHaveAttribute(
      "title",
      /^The version of pact-web you are using\./,
    );
  });
}
