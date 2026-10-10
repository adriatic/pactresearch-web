import { test, expect } from "@playwright/test";

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
// small text, measured as the browser draws it, opacity included.
test("the badge is readable: contrast at least 4.5 to 1 against its background", async ({
  page,
}) => {
  await page.goto("/login");
  const badge = page.locator("[data-build-label]");
  const ratio = await badge.evaluate((el) => {
    const s = getComputedStyle(el);
    const rgb = (v: string) => v.match(/[\d.]+/g)!.map(Number);
    const [r, g, b] = rgb(s.color);
    const [br, bg, bb, ba = 1] = rgb(s.backgroundColor);
    const opacity = Number(s.opacity);
    // Background over the white page, then the text over that, faded by
    // the element's opacity.
    const back = [br, bg, bb].map((c) => c * ba + 255 * (1 - ba));
    const text = [r, g, b].map((c, i) => c * opacity + back[i] * (1 - opacity));
    const lum = (c: number[]) => {
      const [R, G, B] = c.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const [hi, lo] = [lum(back), lum(text)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await expect(badge).toHaveAttribute(
    "title",
    /^The version of pact-web you are using\./,
  );
});
