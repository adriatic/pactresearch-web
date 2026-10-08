import { expect, type Locator, type Page } from "@playwright/test";

// Task 54 moved every per-row action in the Explorer tree -- Export,
// Delete, and the new Rename -- behind a "⋮" menu on the row itself,
// replacing the inline buttons. Specs that used to click the button
// directly now have to open the menu first.
//
// That two-step lives here rather than being copied into each spec so
// the next change to the menu is one edit, not eleven. Not a .spec.ts
// file, so Playwright's default testMatch does not collect it as a
// test.
//
// The menu is `position: fixed` but still a DOM descendant of its row,
// so scoping the menuitem to the row stays correct and keeps rows
// distinguishable from each other.
//
// ----------------------------------------------------------------
// If a spec suddenly counts more buttons than it expects, read this.
//
// Each row's trigger is labelled "Actions for <row name>", because a
// bare "Actions" would make every row's trigger identical to assistive
// tech and to these specs. Playwright matches accessible names by
// CASE-INSENSITIVE SUBSTRING unless told otherwise, so a page-level
//
//     page.getByRole("button", { name: "Run" })
//
// also matches the trigger of any row whose name contains "run" --
// and E2E rows are conventionally named "E2E <feature> notebook ...",
// where <feature> is often the very word the spec is looking for.
// This bit header-run-button ("E2E header-run notebook") and
// continue-button ("E2E continue discussion"); measured, the loose
// locator found 3 where 1 was meant.
//
// It surfaces intermittently, not reliably: it only misfires once the
// tree has finished rendering, so it depends on whether the assertion
// wins that race.
//
// The fix is `exact: true` on the page-level locator, which narrows
// the locator without weakening the assertion. Scoping to a container
// that holds no tree rows (a header, a dialog) works too.
// ----------------------------------------------------------------
export async function chooseRowAction(
  row: Locator,
  rowName: string,
  action: string,
) {
  await row.getByRole("button", { name: `Actions for ${rowName}` }).click();
  const item = row.getByRole("menuitem", { name: action, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

// Task 60 moved "Add discussion" out of the sidebar's separate panel
// and into the notebook row's own ⋮ menu, alongside Rename, Export and
// Delete. Specs that used the panel go through here instead.
//
// Expands the notebook first when needed: the menu lives on the
// notebook row, which is always present, but callers usually want the
// resulting discussion row visible afterwards.
export async function addDiscussionViaRowMenu(
  page: import("@playwright/test").Page,
  notebookName: string,
  discussionName: string,
) {
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await chooseRowAction(row, notebookName, "Add discussion");

  const dialog = page.getByRole("dialog", { name: "Add discussion" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Name:").fill(discussionName);
  await dialog.getByRole("button", { name: "Add discussion" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

// Task 68: Delete notebook / Delete discussion now open an in-app
// dialog instead of the browser's window.confirm. Presses its Delete
// button -- what `page.once("dialog", (d) => d.accept())` used to do.
export async function confirmDeleteDialog(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: /^Delete (notebook|discussion)$/,
  });
  await dialog
    .getByRole("button", { name: /^Delete (notebook|discussion)$/ })
    .click();
}
