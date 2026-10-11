import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 84. A notebook or discussion deleted in one tab, while another tab
// shows it. On coming back to that other tab (task 74's reload), the work
// area must agree with the tree: the title line, the prompt box and the
// prompt and response panel give way to one plain message, and unsent
// prompt text stays reachable. Runs in chromium and webkit-ipad
// (playwright.config.ts).
//
// Tab switches are sent by hand, as in task 74's tests: a headless
// browser sends no blur/hidden/visible/focus when a tab is brought to the
// front (checked in Chromium and WebKit).

const DISCUSSION_GONE = "This discussion was deleted in another tab or window.";
const NOTEBOOK_GONE = "This notebook was deleted in another tab or window.";
const OPEN = "verify the key remains hidden";

test.setTimeout(90_000);

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
  ) as { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
}

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

interface Seeded {
  admin: SupabaseClient;
  userId: string;
  notebookName: string;
  notebookId: string;
  discussionId: string;
}

// One user. A notebook holding the open discussion (one earlier turn) and
// a sibling -- or, with `emptyNotebook`, a notebook with no discussions,
// so nothing is open on load.
async function seedAndSignIn(
  page: Page,
  context: BrowserContext,
  options: { emptyNotebook?: boolean; draft?: string } = {},
): Promise<Seeded> {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localSupabase();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-stale-${suffix}@example.com`;
  const password = "correct horse battery staple 84!";
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no user");
  const userId = created.user.id;
  const notebookName = `E2E stale notebook ${suffix}`;
  const { data: nb } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  let discussionId = "";
  if (!options.emptyNotebook) {
    const { data: d } = await admin
      .from("discussions")
      .insert({
        notebook_id: nb!.id,
        user_id: userId,
        name: OPEN,
        draft_content: options.draft ? doc(options.draft) : null,
      })
      .select()
      .single();
    discussionId = d!.id;
    await admin.from("discussions").insert({
      notebook_id: nb!.id,
      user_id: userId,
      name: "sibling discussion",
    });
    await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userId,
      prompt_text: "EARLIER PROMPT",
      response: "EARLIER RESPONSE",
      model: "m",
      resolved_model: "m",
    });
  }

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
  const { error: signInError } = await client.auth.signInWithPassword({
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
  return { admin, userId, notebookName, notebookId: nb!.id, discussionId };
}

async function expandNotebook(page: Page, notebookName: string, child: string) {
  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const childRow = page.getByRole("treeitem", { name: child, exact: true });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if ((await childRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(childRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return { notebookRow, childRow };
}

async function openDiscussion(page: Page, notebookName: string) {
  const { childRow } = await expandNotebook(page, notebookName, OPEN);
  await childRow.click();
  await expect(page.getByText("EARLIER RESPONSE")).toBeVisible({
    timeout: 15_000,
  });
}

// The other tab: same signed-in browser, deleting through the tree's own
// row menu and confirmation, as Nik did.
async function deleteInOtherTab(
  context: BrowserContext,
  notebookName: string,
  what: "notebook" | "discussion",
) {
  const other = await context.newPage();
  await other.goto("/");
  if (what === "notebook") {
    const row = other.getByRole("treeitem", {
      name: notebookName,
      exact: true,
    });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await chooseRowAction(row, notebookName, "Delete notebook");
    const dialog = other.getByRole("dialog", { name: "Delete notebook" });
    await dialog.getByRole("button", { name: "Delete notebook" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
  } else {
    const { childRow } = await expandNotebook(other, notebookName, OPEN);
    await chooseRowAction(childRow, OPEN, "Delete discussion");
    const dialog = other.getByRole("dialog", { name: "Delete discussion" });
    await dialog.getByRole("button", { name: "Delete discussion" }).click();
    await expect(childRow).toHaveCount(0, { timeout: 15_000 });
  }
  await other.close();
}

// The open discussion's name anywhere outside the tree: the title line.
async function titleLineShowsOpenName(page: Page) {
  return page
    .getByText(OPEN, { exact: true })
    .evaluateAll(
      (els) => els.filter((e) => !e.closest('[role="treeitem"]')).length,
    );
}

async function expectWorkAreaCleared(page: Page, message: string) {
  const header = page.locator("header[data-switch-ms]");
  await expect(page.getByText(message)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await expect(page.getByText("EARLIER RESPONSE")).toHaveCount(0);
  expect(await titleLineShowsOpenName(page)).toBe(0);
  await expect(
    header.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Export discussion" }),
  ).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Settings" })).toBeDisabled();
}

test("notebook deleted in another tab: the work area clears, says so, and keeps the unsent prompt", async ({
  page,
  context,
  browserName,
}) => {
  const { admin, userId, notebookName } = await seedAndSignIn(page, context);
  await openDiscussion(page, notebookName);
  await page.getByLabel("Prompt").fill("MY UNSENT PROMPT, long and precious");
  await expect(page.getByLabel("Prompt")).toContainText("MY UNSENT PROMPT");

  await leavePage(page);
  await deleteInOtherTab(context, notebookName, "notebook");

  // Count the tree's reads from here: the check must reuse task 74's
  // reload, not add requests of its own.
  const reads: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" && !u.search) reads.push(u.pathname);
  });
  await returnToPage(page);

  await expect(page.getByRole("treeitem")).toHaveCount(0, { timeout: 15_000 });
  await expectWorkAreaCleared(page, DISCUSSION_GONE);
  await page.waitForTimeout(1_500);
  expect(reads.filter((p) => p === "/api/notebooks")).toHaveLength(1);
  expect(reads.filter((p) => p === "/api/discussions")).toHaveLength(1);
  expect(reads.filter((p) => p === "/api/activity-rollups")).toHaveLength(1);

  // The unsent prompt is still reachable.
  await page.getByText("Show it").click();
  await expect(page.locator("[data-unsent-prompt] pre")).toHaveText(
    "MY UNSENT PROMPT, long and precious",
  );
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy your unsent prompt" }).click();
    await expect(page.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "MY UNSENT PROMPT, long and precious",
    );
  }

  // Nothing was recreated for the deleted notebook.
  const { count: notebooks } = await admin
    .from("notebooks")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  const { count: discussions } = await admin
    .from("discussions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  expect([notebooks, discussions]).toEqual([0, 0]);
});

test("only the discussion deleted in another tab: the same, and picking another discussion clears the message", async ({
  page,
  context,
}) => {
  const { notebookName } = await seedAndSignIn(page, context);
  await openDiscussion(page, notebookName);

  await leavePage(page);
  await deleteInOtherTab(context, notebookName, "discussion");
  await returnToPage(page);

  await expectWorkAreaCleared(page, DISCUSSION_GONE);
  // The notebook and the sibling are still there, in the tree.
  const sibling = page.getByRole("treeitem", {
    name: "sibling discussion",
    exact: true,
  });
  await expect(sibling).toBeVisible();
  await expect(page.getByRole("treeitem", { name: OPEN })).toHaveCount(0);

  await sibling.click();
  await expect(page.getByText(DISCUSSION_GONE)).toHaveCount(0);
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(
    page.getByText("sibling discussion", { exact: true }).last(),
  ).toBeVisible();
});

test("a prompt that was already run is not offered as unsent", async ({
  page,
  context,
}) => {
  // After a run the prompt box keeps the prompt; that is not unsent text.
  const { notebookName } = await seedAndSignIn(page, context, {
    draft: "EARLIER PROMPT",
  });
  await openDiscussion(page, notebookName);
  await expect(page.getByLabel("Prompt")).toContainText("EARLIER PROMPT");

  await leavePage(page);
  await deleteInOtherTab(context, notebookName, "notebook");
  await returnToPage(page);

  await expectWorkAreaCleared(page, DISCUSSION_GONE);
  await expect(
    page.getByRole("button", { name: "Copy your unsent prompt" }),
  ).toHaveCount(0);
});

test("a selected notebook with no discussion open, deleted in another tab, says the notebook was deleted", async ({
  page,
  context,
}) => {
  const { notebookName } = await seedAndSignIn(page, context, {
    emptyNotebook: true,
  });
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator("h3").click();

  await leavePage(page);
  await deleteInOtherTab(context, notebookName, "notebook");
  await returnToPage(page);

  await expect(page.getByText(NOTEBOOK_GONE)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("treeitem")).toHaveCount(0);
});
