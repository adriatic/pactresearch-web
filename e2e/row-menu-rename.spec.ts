import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 54. The per-row "⋮" menu, and the Rename action in it.
//
// Two things are being pinned here, and the second is the one that
// actually decays. The first is that Rename works end to end -- the
// row menu opens, the dialog saves, and the new name is really in the
// database rather than only on screen. The second is that renaming the
// ACTIVE discussion also updates the header, which reads its name from
// useDiscussionExecution's own copy loaded with the discussion, not
// from the tree. Those are two separate pieces of state, so they can
// silently drift apart, and the user sees a tree and a header
// disagreeing about what they are looking at.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

test.setTimeout(90_000);

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-rename-${suffix}@example.com`;
  const password = "correct horse battery staple 54!";
  const notebookName = `E2E rename notebook ${suffix}`;
  const discussionName = `E2E rename discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw userErr ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  const { data: discussion } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  const otherDiscussionName = `E2E rename other ${suffix}`;
  await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: otherDiscussionName,
  });

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
  await page.getByRole("treeitem", { name: discussionName }).click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });

  return {
    admin,
    notebookId: notebook!.id,
    discussionId: discussion!.id,
    notebookName,
    discussionName,
    otherDiscussionName,
    suffix,
  };
}

test("the row menu holds the row's actions, and Rename really renames a notebook", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName, suffix } = await seed(page, context);

  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const trigger = notebookRow.getByRole("button", {
    name: `Actions for ${notebookName}`,
  });

  // The actions are behind the menu, not sitting on the row.
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(
    notebookRow.getByRole("button", { name: "Delete notebook" }),
  ).toHaveCount(0);

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = notebookRow.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Rename",
    "Export",
    "Delete notebook",
  ]);

  // Escape dismisses without doing anything.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // Rename for real.
  const renamed = `E2E renamed notebook ${suffix}`;
  await chooseRowAction(notebookRow, notebookName, "Rename");
  const dialog = page.getByRole("dialog", { name: "Rename notebook" });
  await expect(dialog).toBeVisible();
  // Prefilled with the current name, not empty.
  await expect(dialog.getByLabel("Name:")).toHaveValue(notebookName);
  // Saving the name it already has is pointless, so it's disabled.
  await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();

  await dialog.getByLabel("Name:").fill(renamed);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // On screen...
  await expect(
    page.getByRole("treeitem", { name: renamed, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toHaveCount(0);

  // ...and in the database, which is the part a re-render can fake.
  const { data: row } = await admin
    .from("notebooks")
    .select("name")
    .eq("id", notebookId)
    .single();
  expect(row?.name).toBe(renamed);
});

test("renaming the active discussion updates the tree AND the header", async ({
  page,
  context,
}) => {
  const { admin, discussionId, discussionName, suffix } = await seed(
    page,
    context,
  );

  const header = page.getByRole("group", { name: "Active discussion" });
  await expect(header).toContainText(discussionName);

  const renamed = `E2E renamed discussion ${suffix}`;
  const discussionRow = page.getByRole("treeitem", {
    name: discussionName,
    exact: true,
  });
  await chooseRowAction(discussionRow, discussionName, "Rename");

  const dialog = page.getByRole("dialog", { name: "Rename discussion" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name:").fill(renamed);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  await expect(
    page.getByRole("treeitem", { name: renamed, exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // The header is separate state from the tree -- this is the assertion
  // that catches them drifting apart.
  await expect(header).toContainText(renamed, { timeout: 15_000 });
  await expect(header).not.toContainText(discussionName);

  const { data: row } = await admin
    .from("discussions")
    .select("name")
    .eq("id", discussionId)
    .single();
  expect(row?.name).toBe(renamed);
});

test("a rejected rename keeps the dialog open with the typed value, and changes nothing", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context);

  // A server-side rejection the UI can't pre-empt, so the dialog's own
  // failure path is what's under test rather than its disabled-button
  // guard.
  await page.route("**/api/notebooks?id=*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "name must be a non-empty string." }),
    });
  });

  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  await chooseRowAction(notebookRow, notebookName, "Rename");
  const dialog = page.getByRole("dialog", { name: "Rename notebook" });
  await dialog.getByLabel("Name:").fill("Something the server refuses");
  await dialog.getByRole("button", { name: "Rename" }).click();

  // Still open, still holding what was typed, and saying why.
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("name must be a non-empty string."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name:")).toHaveValue(
    "Something the server refuses",
  );
  // Not stuck mid-save -- the button is usable again.
  await expect(dialog.getByRole("button", { name: "Rename" })).toBeEnabled();

  const { data: row } = await admin
    .from("notebooks")
    .select("name")
    .eq("id", notebookId)
    .single();
  expect(row?.name).toBe(notebookName);
});

test("opening a row's menu does not select that row", async ({
  page,
  context,
}) => {
  const { discussionName, otherDiscussionName } = await seed(page, context);

  const header = page.getByRole("group", { name: "Active discussion" });
  await expect(header).toContainText(discussionName);

  // The "⋮" sits inside a tree item that selects on click, so the
  // trigger has to stop the event reaching it. Without that, reaching
  // for Rename or Export on some other discussion would switch the
  // user away from the one they are working in -- and, because
  // switching saves and reloads the composer, do it in a way that
  // touches real state rather than just the view.
  const otherRow = page.getByRole("treeitem", {
    name: otherDiscussionName,
    exact: true,
  });
  await otherRow
    .getByRole("button", { name: `Actions for ${otherDiscussionName}` })
    .click();
  await expect(otherRow.getByRole("menu")).toBeVisible();

  await expect(header).toContainText(discussionName);
  await expect(header).not.toContainText(otherDiscussionName);

  // Dismissing by clicking elsewhere closes it, and still doesn't
  // select anything.
  await page.getByRole("heading", { name: "Explorer" }).click();
  await expect(otherRow.getByRole("menu")).toHaveCount(0);
  await expect(header).toContainText(discussionName);
});
