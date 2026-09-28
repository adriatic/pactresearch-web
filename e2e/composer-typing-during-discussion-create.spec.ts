import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 52: notebooks are created through the New Notebook modal now. The
// old flat form still exists in NotebookCreator but is hidden behind
// SHOW_LEGACY_NOTEBOOK_FORM, so these specs drive the modal instead.
async function createNotebookViaModal(page: Page, notebookName: string) {
  await page
    .locator("header")
    .getByRole("button", { name: "New Notebook" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name:").fill(notebookName);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(dialog).toBeHidden();
}

// RETARGETED BY TASK 60 -- the window this guarded no longer exists.
//
// Adding a discussion moved from an inline panel into a modal dialog.
// The overlay owns the interaction until creation completes, so there
// is no longer any way for a user to type into the composer while the
// POST is in flight: the keystrokes cannot reach it. The bug is not
// merely fixed, it is unreachable.
//
// So this no longer reproduces the race -- it proves the race is
// structurally prevented, with the POST still artificially delayed to
// hold the window wide open. Deleting the spec would have thrown away
// the guard entirely: if the entry point ever became non-modal again,
// this fails and says why.
//
// Original rationale, kept because it is what the property protects:
//
// Task 36, second follow-up (Nik's own "keyboard typing still fails, even
// with the switch-load fix on preview" report). composer-new-discussion-
// typing-race.spec.ts guards the window *after* activeDiscussionIdRef.current
// has already become the new discussion's real id (its own load resolving
// too fast to be re-typed into). This guards an earlier, previously-unfound
// window: "Create discussion" is itself an async POST
// (NotebookCreator -> onDiscussionCreated -> Workspace's
// setActiveDiscussionId), so activeDiscussionIdRef.current can still hold
// null (or the previous discussion's id) for whatever gets typed in the
// brief span before that POST resolves. Those keystrokes get stamped onto
// the wrong owner via contentOwnerRef -- if the brand-new discussion's own
// (typically fast, since there's nothing to fetch) history/draft load then
// resolves before any further keystroke corrects the ownership stamp, the
// ownership check alone still wrongly permits an overwrite, even though
// real, visible, unsaved text is sitting in the composer right now.
//
// Reproduced here by delaying the discussion-creation POST itself
// (/api/discussions, POST) rather than the subsequent GET fetches the
// switch-load effect makes -- widens this specific, earlier window to
// something reliably observable.

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

test.setTimeout(60_000);

test("typing during the discussion-creation request itself survives the new discussion's own load resolving afterward", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-typing-during-create-${suffix}@example.com`;
  const password = "correct horse battery staple 36b!";
  const notebookName = `E2E typing-during-create notebook ${suffix}`;
  const discussionName = `E2E typing-during-create discussion ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            capturedCookies.push({ name, value });
          }
        });
      },
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;

  await context.addCookies(
    capturedCookies.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );

  // Delay only the discussion-creation POST itself -- the exact request
  // whose completion is what actually assigns activeDiscussionIdRef.current
  // to the new discussion's real id (via onDiscussionCreated).
  await page.route("**/api/discussions", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  await createNotebookViaModal(page, notebookName);

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });

  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toHaveText("");

  // Open the dialog from the notebook's own row menu and submit. The
  // POST is artificially delayed, so everything below happens while
  // creation is still in flight -- the exact window that used to be
  // typable.
  const menuTrigger = notebookRow.getByRole("button", {
    name: `Actions for ${notebookName}`,
  });
  await menuTrigger.click();
  await notebookRow
    .getByRole("menuitem", { name: "Add discussion", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Add discussion" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name:").fill(discussionName);
  await dialog.getByRole("button", { name: "Add discussion" }).click();

  // Still mid-flight: the dialog is up and has not resolved.
  await expect(dialog).toBeVisible();

  // The composer cannot receive these keystrokes. Typing blind is the
  // point -- a real user hammering the keyboard during the delay.
  const typedText = "typed while discussion creation was still in flight";
  await page.keyboard.type(typedText);
  await expect(prompt).toHaveText("");

  // And it is not merely unfocused: the overlay physically intercepts
  // pointer events, so the composer cannot be clicked into either.
  // (A short timeout: the assertion is that this CANNOT succeed.)
  await expect(async () => {
    await prompt.click({ timeout: 750 });
  }).rejects.toThrow();

  // Creation completes normally once the delay elapses.
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: discussionName, exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // Nothing was captured into the wrong owner, because nothing could be.
  await page.waitForTimeout(1500);
  await expect(prompt).toHaveText("");
});
