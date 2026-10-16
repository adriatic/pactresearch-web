import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";
import { addDiscussionViaRowMenu, chooseRowAction } from "./rowMenuActions";

// Task 95. Task 84's "deleted in another tab or window" notice, with
// Task 93's unsent prompt, belongs to the moment the open discussion
// disappeared. Any later action in the tree (or New Notebook) clears it,
// and the work area looks as it does on a fresh start. Doing nothing, or
// cancelling a dialog, keeps it, with Copy and "Show it" still working.
// Runs in chromium and webkit-ipad (playwright.config.ts).
//
// The user signs up and seeds their own rows with the anon key and their
// own session (RLS), so no service-role key is needed.

const DISCUSSION_GONE = "This discussion was deleted in another tab or window.";
const OPEN = "Task 95 open discussion";
const SIBLING = "Task 95 sibling in A";
const IN_B = "Task 95 discussion in B";
const UNSENT = "Task 95 unsent prompt text";

test.setTimeout(90_000);

// Tab switches are sent by hand, as in Task 74's and Task 84's tests: a
// headless browser sends no blur/hidden/visible/focus when a tab is
// brought to the front.
async function leavePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function returnToPage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

function localSupabase() {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
}

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

interface Names {
  a: string;
  b: string;
  c: string;
}

// Notebook A holds the open discussion (with an unsent draft) and a
// sibling; notebook B holds one discussion; notebook C is empty.
async function seedAndSignIn(
  page: Page,
  context: BrowserContext,
): Promise<Names> {
  const { API_URL, ANON_KEY } = localSupabase();
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (all) =>
        all.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await client.auth.signUp({
    email: `e2e-task95-${suffix}@example.com`,
    password: "correct horse battery staple 95!",
  });
  if (error || !data.user) throw error ?? new Error("no user");
  const userId = data.user.id;
  const names: Names = {
    a: `E2E task 95 A ${suffix}`,
    b: `E2E task 95 B ${suffix}`,
    c: `E2E task 95 C ${suffix}`,
  };
  const ids: Record<string, string> = {};
  for (const key of ["a", "b", "c"] as const) {
    const { data: nb, error: nbError } = await client
      .from("notebooks")
      .insert({ user_id: userId, name: names[key], category: "Dev Test" })
      .select()
      .single();
    if (nbError) throw nbError;
    ids[key] = nb.id;
  }
  const { error: dError } = await client.from("discussions").insert([
    {
      notebook_id: ids.a,
      user_id: userId,
      name: OPEN,
      draft_content: doc(UNSENT),
    },
    { notebook_id: ids.a, user_id: userId, name: SIBLING },
    { notebook_id: ids.b, user_id: userId, name: IN_B },
  ]);
  if (dError) throw dError;
  await context.addCookies(
    jar.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  return names;
}

async function expandNotebook(
  page: Page,
  notebookName: string,
  childName: string,
) {
  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const childRow = page.getByRole("treeitem", { name: childName, exact: true });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if ((await childRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(childRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return childRow;
}

function promptBox(page: Page) {
  return page.getByRole("textbox", { name: "Prompt", exact: true });
}

function notebookRow(page: Page, name: string) {
  return page.getByRole("treeitem", { name, exact: true });
}

// Opens the discussion with the unsent draft, deletes it in a second tab,
// and comes back to the notice (Nik's steps 1 to 3). Notebooks A and B
// are left open in the tree.
async function reachNotice(page: Page, context: BrowserContext) {
  const names = await seedAndSignIn(page, context);
  // B is opened first, so its discussion can be used later without
  // clicking B's row (a click on a notebook row picks it, which clears
  // the notice on its own and would hide what is being tested).
  await expandNotebook(page, names.b, IN_B);
  await (await expandNotebook(page, names.a, OPEN)).click();
  await expect(promptBox(page)).toContainText(UNSENT, { timeout: 15_000 });

  await leavePage(page);
  const other = await context.newPage();
  await other.goto("/");
  const row = await expandNotebook(other, names.a, OPEN);
  await chooseRowAction(row, OPEN, "Delete discussion");
  await other
    .getByRole("dialog", { name: "Delete discussion" })
    .getByRole("button", { name: "Delete discussion" })
    .click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await other.close();
  await returnToPage(page);
  await expectNoticeShowing(page);
  await expect(discussionRow(page, IN_B)).toBeVisible();
  await expect(discussionRow(page, SIBLING)).toBeVisible();
  return names;
}

function discussionRow(page: Page, name: string) {
  return page.getByRole("treeitem", { name, exact: true });
}

async function expectNoticeShowing(page: Page) {
  await expect(page.getByText(DISCUSSION_GONE)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Copy your unsent prompt" }),
  ).toBeVisible();
}

// What a fresh start shows with no discussion open: no notice, no old
// prompt text, the (empty) prompt box and the hint in the panel below.
async function expectFreshStart(page: Page) {
  await expect(page.getByText(DISCUSSION_GONE)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy your unsent prompt" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-unsent-prompt]")).toHaveCount(0);
  await expect(page.getByText(UNSENT)).toHaveCount(0);
  await expect(promptBox(page)).toBeVisible();
  await expect(promptBox(page)).toHaveText("");
  await expect(page.locator("[data-empty-hint]")).toHaveCount(1);
}

async function deleteRow(
  page: Page,
  rowName: string,
  kind: "notebook" | "discussion",
) {
  const row = page.getByRole("treeitem", { name: rowName, exact: true });
  await chooseRowAction(row, rowName, `Delete ${kind}`);
  const dialog = page.getByRole("dialog", { name: `Delete ${kind}` });
  await dialog.getByRole("button", { name: `Delete ${kind}` }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}

async function renameRow(page: Page, rowName: string, newName: string) {
  const row = page.getByRole("treeitem", { name: rowName, exact: true });
  await chooseRowAction(row, rowName, "Rename");
  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await dialog.getByLabel("Name:").fill(newName);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: newName, exact: true }),
  ).toBeVisible();
}

test("doing nothing keeps the notice; Show it and Copy still work", async ({
  page,
  context,
  browserName,
}) => {
  await reachNotice(page, context);
  await page.waitForTimeout(4_000);
  await expectNoticeShowing(page);
  await page.getByText("Show it").click();
  await expect(page.locator("[data-unsent-prompt] pre")).toHaveText(UNSENT);
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy your unsent prompt" }).click();
    await expect(page.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      UNSENT,
    );
  }
  await expectNoticeShowing(page);
});

test("cancelling a delete or a rename keeps the notice", async ({
  page,
  context,
}) => {
  const names = await reachNotice(page, context);
  const rowB = notebookRow(page, names.b);
  await chooseRowAction(rowB, names.b, "Delete notebook");
  const del = page.getByRole("dialog", { name: "Delete notebook" });
  await del.getByRole("button", { name: "Cancel" }).click();
  await expect(del).toBeHidden();
  await expectNoticeShowing(page);

  await chooseRowAction(rowB, names.b, "Rename");
  const ren = page.getByRole("dialog", { name: /^Rename / });
  await ren.getByRole("button", { name: "Cancel" }).click();
  await expect(ren).toBeHidden();
  await expectNoticeShowing(page);
});

test("picking another discussion clears the notice", async ({
  page,
  context,
}) => {
  await reachNotice(page, context);
  await discussionRow(page, IN_B).click();
  await expect(page.getByText(DISCUSSION_GONE)).toHaveCount(0);
  await expect(page.getByText(UNSENT)).toHaveCount(0);
  await expect(promptBox(page)).toBeVisible();
});

test("pressing New Notebook clears the notice, even if then cancelled", async ({
  page,
  context,
}) => {
  await reachNotice(page, context);
  await page.getByRole("button", { name: "New Notebook", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectFreshStart(page);
});

test("Add discussion in another notebook clears the notice", async ({
  page,
  context,
}) => {
  const names = await reachNotice(page, context);
  await addDiscussionViaRowMenu(page, names.b, "Task 95 added");
  await expect(page.getByText(DISCUSSION_GONE)).toHaveCount(0);
  await expect(page.getByText(UNSENT)).toHaveCount(0);
  await expect(promptBox(page)).toBeVisible();
});

test("deleting another discussion clears the notice", async ({
  page,
  context,
}) => {
  await reachNotice(page, context);
  await deleteRow(page, IN_B, "discussion");
  await expectFreshStart(page);
});

test("deleting another notebook clears the notice", async ({
  page,
  context,
}) => {
  const names = await reachNotice(page, context);
  await deleteRow(page, names.c, "notebook");
  await expectFreshStart(page);
});

test("deleting the notebook that held the vanished discussion clears the notice", async ({
  page,
  context,
}) => {
  const names = await reachNotice(page, context);
  await deleteRow(page, names.a, "notebook");
  await expectFreshStart(page);
});

test("renaming a notebook clears the notice", async ({ page, context }) => {
  const names = await reachNotice(page, context);
  await renameRow(page, names.b, `${names.b} renamed`);
  await expectFreshStart(page);
});

test("renaming a discussion clears the notice", async ({ page, context }) => {
  await reachNotice(page, context);
  await renameRow(page, IN_B, "Task 95 renamed discussion");
  await expectFreshStart(page);
});
