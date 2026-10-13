import { test, expect } from "@playwright/test";
import { signIn } from "./importHelpers";
import { chooseRowAction } from "./rowMenuActions";

// Task 91. With no discussion open, the work area says how to get one,
// and the advice depends on whether there is a notebook to add it to.
// The same hint sits under Task 84's "deleted in another tab or window"
// message (stale-work-area.spec.ts checks it there). Runs in chromium and
// webkit-ipad (playwright.config.ts).

const WITH_NOTEBOOKS =
  "Pick a discussion in the tree, add a discussion to a notebook (⋮ menu, then Add discussion), or press New Notebook.";
const NO_NOTEBOOKS = "Press New Notebook to start.";

test("no notebooks: the hint says to press New Notebook", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  await expect(page.getByText(NO_NOTEBOOKS, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(WITH_NOTEBOOKS)).toHaveCount(0);
  // The button the hint names is there, under that name.
  await expect(
    page.getByRole("button", { name: "New Notebook", exact: true }),
  ).toBeVisible();
});

test("notebooks but no discussion open: the hint says how to add one, and follows the notebooks", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  const name = `E2E hint notebook ${Date.now()}`;
  await admin
    .from("notebooks")
    .insert({ user_id: userId, name, category: "Dev Test" });
  await page.reload();

  await expect(page.getByText(WITH_NOTEBOOKS, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(NO_NOTEBOOKS)).toHaveCount(0);

  // The menu and item the hint names are the real ones.
  const row = page.getByRole("treeitem", { name, exact: true });
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await expect(
    row.getByRole("button", { name: `Actions for ${name}` }),
  ).toHaveText("⋮");
  await expect(
    row.getByRole("menuitem", { name: "Add discussion", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Deleting the last notebook switches the hint without a reload.
  await chooseRowAction(row, name, "Delete notebook");
  await page
    .getByRole("dialog", { name: "Delete notebook" })
    .getByRole("button", { name: "Delete notebook" })
    .click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(NO_NOTEBOOKS, { exact: true })).toBeVisible();
  await expect(page.getByText(WITH_NOTEBOOKS)).toHaveCount(0);
});

test("while the tree is loading, no hint is shown, so the wrong one never flashes", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await admin
    .from("notebooks")
    .insert({ user_id: userId, name: `E2E hint loading ${Date.now()}` });

  // Every hint that ever appears, from the first paint on.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __hints: string[] }).__hints = seen;
    new MutationObserver(() => {
      document.querySelectorAll("[data-empty-hint]").forEach((el) => {
        const text = el.textContent ?? "";
        if (!seen.includes(text)) seen.push(text);
      });
    }).observe(document, { subtree: true, childList: true });
  });
  // Hold the tree's notebook list for 2 seconds.
  await page.route("**/api/notebooks", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((r) => setTimeout(r, 2_000));
    }
    await route.continue();
  });

  await page.reload();
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await expect(page.locator("[data-empty-hint]")).toHaveCount(0);

  await expect(page.getByText(WITH_NOTEBOOKS, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { __hints: string[] }).__hints,
    ),
  ).toEqual([WITH_NOTEBOOKS]);
});
