import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";
import type { Locator } from "@playwright/test";

// The confirmation gate on Delete.
//
// It has existed since the Explorer was first built, but nothing ever
// tested it: seven specs accept the dialog to get past it, and not one
// asserts what it says or that dismissing it actually cancels. So
// "cancel leaves the notebook untouched" was believed rather than
// known, and the message could have drifted to say anything at all.
//
// The count in the message is new. "and all its discussions" read the
// same for a notebook with eleven as for one with none.
//
// Task 68: the confirmation is now the in-app DeleteDialog (same frame as
// Rename and Add discussion), not the browser's window.confirm. Every test
// here fails if a native dialog appears at all.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
}

test.setTimeout(90_000);

async function seed(
  page: Page,
  context: BrowserContext,
  discussionCount: number,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-delconf-${suffix}@example.com`;
  const password = "correct horse battery staple 61!";
  const notebookName = `E2E delconf notebook ${suffix}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    { email, password, email_confirm: true },
  );
  if (userError || !created.user) throw userError ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();

  for (let i = 0; i < discussionCount; i++) {
    await admin.from("discussions").insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: `E2E delconf discussion ${i} ${suffix}`,
    });
  }

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;
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
  return { admin, notebookId: notebook!.id, notebookName, userId };
}

// Fails the test if the browser's own confirm/alert ever appears.
function forbidNativeDialogs(page: Page) {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(
      `a native ${dialog.type()} dialog appeared: ${dialog.message()}`,
    );
  });
}

async function openDeleteDialog(page: Page, notebookName: string) {
  forbidNativeDialogs(page);
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await chooseRowAction(row, notebookName, "Delete notebook");
  const dialog = page.getByRole("dialog", { name: "Delete notebook" });
  await expect(dialog).toBeVisible();
  return { row, dialog };
}

async function expectUntouched(
  page: Page,
  admin: Awaited<ReturnType<typeof seed>>["admin"],
  notebookId: string,
  notebookName: string,
  discussionCount: number,
) {
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toBeVisible();
  // Checked in the database directly, because a row lingering in a stale
  // tree would look identical to one that was never deleted.
  const { data: notebooks } = await admin
    .from("notebooks")
    .select("id")
    .eq("id", notebookId);
  expect(notebooks).toHaveLength(1);
  const { data: discussions } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(discussions).toHaveLength(discussionCount);
  // And a reload proves it, rather than trusting the client's own view.
  await page.reload();
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

test("the in-app dialog names the notebook, states the blast radius, and says it is permanent", async ({
  page,
  context,
}) => {
  const { notebookName } = await seed(page, context, 3);
  const { dialog } = await openDeleteDialog(page, notebookName);

  await expect(
    dialog.getByRole("heading", { name: "Delete notebook" }),
  ).toBeVisible();
  await expect(dialog).toContainText(`Delete notebook ${notebookName}?`);
  await expect(dialog).toContainText(
    "This will also delete its 3 discussions.",
  );
  await expect(dialog).toContainText("This cannot be undone.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Delete notebook" }),
  ).toBeVisible();
});

test("one discussion reads as singular, and none says so plainly", async ({
  page,
  context,
}) => {
  const single = await seed(page, context, 1);
  const { dialog } = await openDeleteDialog(page, single.notebookName);
  await expect(dialog).toContainText("This will also delete its 1 discussion.");
  await expect(dialog).not.toContainText("1 discussions");
});

test("an empty notebook says it has none, rather than '0 discussions'", async ({
  page,
  context,
}) => {
  const empty = await seed(page, context, 0);
  const { dialog } = await openDeleteDialog(page, empty.notebookName);
  await expect(dialog).toContainText("It has no discussions.");
  await expect(dialog).not.toContainText("0 discussion");
});

test("Cancel leaves the notebook AND its discussions untouched", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 2);
  const { dialog } = await openDeleteDialog(page, notebookName);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expectUntouched(page, admin, notebookId, notebookName, 2);
});

test("Escape cancels, and leaves the notebook untouched", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 2);
  const { dialog } = await openDeleteDialog(page, notebookName);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expectUntouched(page, admin, notebookId, notebookName, 2);
});

test("Enter on its own does not delete: focus starts on Cancel", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 2);
  const { dialog } = await openDeleteDialog(page, notebookName);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expectUntouched(page, admin, notebookId, notebookName, 2);
});

test("Delete notebook deletes the notebook and its discussions", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 2);
  const { row, dialog } = await openDeleteDialog(page, notebookName);
  await dialog.getByRole("button", { name: "Delete notebook" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0, { timeout: 15_000 });

  const { data: notebooks } = await admin
    .from("notebooks")
    .select("id")
    .eq("id", notebookId);
  expect(notebooks).toHaveLength(0);
  const { data: discussions } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(discussions).toHaveLength(0);

  await page.reload();
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toHaveCount(0);
});

test("discussion delete uses the same in-app dialog", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 1);
  forbidNativeDialogs(page);
  const { data: rows } = await admin
    .from("discussions")
    .select("id, name")
    .eq("notebook_id", notebookId);
  const discussionName = rows![0].name as string;

  // Expand the notebook with its chevron if the tree has not already.
  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  if ((await notebookRow.getAttribute("aria-expanded")) !== "true") {
    await notebookRow.press("ArrowRight");
  }
  const discussionRow = page.getByRole("treeitem", {
    name: discussionName,
    exact: true,
  });
  await expect(discussionRow).toBeVisible();
  await chooseRowAction(discussionRow, discussionName, "Delete discussion");

  const dialog = page.getByRole("dialog", { name: "Delete discussion" });
  await expect(dialog).toContainText(`Delete discussion ${discussionName}?`);
  await expect(dialog).toContainText("This cannot be undone.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const { data: still } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(still).toHaveLength(1);

  await chooseRowAction(discussionRow, discussionName, "Delete discussion");
  await dialog.getByRole("button", { name: "Delete discussion" }).click();
  await expect(discussionRow).toHaveCount(0, { timeout: 15_000 });
  const { data: gone } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(gone).toHaveLength(0);
});

// The box, its overlay and its buttons, as the browser actually draws them.
async function looks(dialog: Locator) {
  return dialog.evaluate((section) => {
    const s = getComputedStyle(section);
    const o = getComputedStyle(section.parentElement!);
    const buttons = [...section.querySelectorAll("button")];
    const b = getComputedStyle(buttons[buttons.length - 1]);
    const row = buttons[buttons.length - 1].parentElement!;
    return {
      width: section.getBoundingClientRect().width,
      background: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: s.padding,
      overlay: o.backgroundColor,
      overlayPosition: o.position,
      headingSize: getComputedStyle(section.querySelector("h2")!).fontSize,
      buttonPadding: b.padding,
      buttonBorder: `${b.borderTopWidth} ${b.borderTopStyle} ${b.borderTopColor}`,
      buttonRadius: b.borderRadius,
      buttonFont: b.fontSize,
      buttonRowMarginTop: getComputedStyle(row).marginTop,
      cancelFirst: buttons[0].textContent === "Cancel",
    };
  });
}

test("it looks exactly like the Rename and Add discussion dialogs", async ({
  page,
  context,
}) => {
  const { notebookName } = await seed(page, context, 1);
  forbidNativeDialogs(page);
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });

  await chooseRowAction(row, notebookName, "Rename");
  const rename = page.getByRole("dialog", { name: "Rename notebook" });
  const renameLooks = await looks(rename);
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);

  await chooseRowAction(row, notebookName, "Add discussion");
  const add = page.getByRole("dialog", { name: "Add discussion" });
  const addLooks = await looks(add);
  await page.keyboard.press("Escape");
  await expect(add).toHaveCount(0);

  await chooseRowAction(row, notebookName, "Delete notebook");
  const del = page.getByRole("dialog", { name: "Delete notebook" });
  const deleteLooks = await looks(del);
  await page.keyboard.press("Escape");

  expect(deleteLooks).toEqual(renameLooks);
  expect(deleteLooks).toEqual(addLooks);
});
