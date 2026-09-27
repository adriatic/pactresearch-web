import { expect, type Locator } from "@playwright/test";

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
