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

  // .last(), not .nth(1): task 52 hid the flat notebook-creation
  // form, so the discussion Name field is no longer the second one on
  // the page. .last() picks it either way, including if that form is
  // ever restored, since it renders after.
  await page.getByLabel("Name:").last().fill(discussionName);
  // Awaited -- click() only waits for the click to actually dispatch (an
  // essentially instant DOM event), not for handleCreateDiscussion's own
  // async body to finish; firing this concurrently with the next action
  // (tried earlier) let the two interleave unpredictably over the same
  // CDP connection and silently dropped the click's own POST entirely
  // (confirmed via network logging -- zero POSTs to /api/discussions).
  // exact: true for the same reason as above: this spec's discussion is
  // named "E2E typing-during-create discussion ...", which contains
  // "create discussion", so once that row exists its "⋮" trigger
  // ("Actions for <row name>") also matches the loose locator. It does
  // not exist yet at this line -- this is pre-emptive, not a fix.
  await page
    .getByRole("button", { name: "Create discussion", exact: true })
    .click();

  const prompt = page.getByLabel("Prompt");
  await prompt.click();
  const typedText = "typed while discussion creation was still in flight";
  // No inter-keystroke delay -- all characters land within a few tens of
  // ms, guaranteed to finish well before the artificially-delayed POST
  // resolves, so nothing corrects contentOwnerRef.current afterward. This
  // is the scenario that matters: a user who finishes typing and pauses
  // (to think, or right before hitting Run) while creation is still
  // completing in the background.
  await page.keyboard.type(typedText);

  // Wait out the artificial POST delay plus a margin, plus enough for the
  // brand-new discussion's own (fast, real) history/draft load to resolve
  // afterward -- long enough for the bug's own window to have definitely
  // closed by now. No further typing happens during this wait.
  await page.waitForTimeout(3000);

  await expect(prompt).toHaveText(typedText);
});
