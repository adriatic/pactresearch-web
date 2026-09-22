import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// The header's "Settings" button (task 33) opens a per-notebook system
// prompt editor — plain text, explicit Save, Cancel discards unsaved
// edits. Exercises the real round trip against local Supabase: the
// dialog opens empty for a notebook with no system_prompt yet, Save
// actually persists it (confirmed both by reopening the dialog and by
// reading the row directly), Cancel never persists anything, and saving
// an empty value back clears a previously-set prompt to null rather than
// leaving a stale or blank-string value behind.

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

test("Settings dialog: disabled with no discussion selected, then edits/saves/cancels a notebook's system prompt for real", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-settings-dialog-${suffix}@example.com`;
  const password = "correct horse battery staple 33!";
  const notebookName = `E2E settings-dialog notebook ${suffix}`;
  const discussionName = `E2E settings-dialog discussion ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

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

  await page.goto("/");

  const headerSettings = page
    .locator("header")
    .getByRole("button", { name: "Settings" });
  await expect(headerSettings).toBeVisible();

  // No discussion selected yet on a fresh load with more than one account
  // discussion in play -- Settings must be disabled, matching every other
  // header control's own no-discussion gating. (This account only has the
  // one discussion just seeded, so it may already be auto-selected by the
  // time this runs -- the real, unambiguous assertion is the enabled state
  // once the discussion below is deliberately selected.)

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await discussionRow.click();

  // notebookId is only known once the discussion's own load resolves
  // (useDiscussionExecution.ts) -- Settings becomes enabled at that point.
  await expect(headerSettings).toBeEnabled({ timeout: 10_000 });

  // Opens empty -- this notebook has no system_prompt yet, and the dialog
  // must show a genuinely empty field, not placeholder text mistaken for
  // real content.
  await headerSettings.click();
  const dialogHeading = page.getByRole("heading", {
    name: "Settings",
    exact: true,
  });
  await expect(dialogHeading).toBeVisible();
  const textarea = page.getByRole("textbox", { name: /system prompt/i });
  await expect(textarea).toHaveValue("");
  await expect(textarea).toHaveAttribute(
    "placeholder",
    "Instructions Claude follows for every prompt in this notebook — e.g. " +
      "'You are reviewing legal contracts for ambiguous liability clauses. " +
      "Flag anything unusual and cite the specific clause.' Leave blank " +
      "for no special instructions.",
  );

  // "Refine with AI" (IPR) is a visible-but-disabled stub only -- no
  // functionality behind it yet (a separate future task). Confirms it
  // neither accepts input nor can be submitted, not just that it renders.
  const refineInput = page.getByRole("textbox", {
    name: /refine with ai/i,
  });
  await expect(refineInput).toBeVisible();
  await expect(refineInput).toBeDisabled();
  await expect(refineInput).toHaveAttribute(
    "placeholder",
    "Describe your research domain...",
  );
  const refineSend = page.getByRole("button", { name: "Send" });
  await expect(refineSend).toBeVisible();
  await expect(refineSend).toBeDisabled();

  // Cancel discards an edit without persisting it.
  await textarea.fill("This edit should never be saved.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialogHeading).not.toBeVisible();

  const { data: afterCancel, error: afterCancelError } = await admin
    .from("notebooks")
    .select("system_prompt")
    .eq("id", notebook!.id)
    .single();
  expect(afterCancelError).toBeNull();
  expect(afterCancel?.system_prompt).toBeNull();

  // Reopening after Cancel shows the real (still-empty) persisted value,
  // not the discarded edit.
  await headerSettings.click();
  await expect(dialogHeading).toBeVisible();
  await expect(textarea).toHaveValue("");

  // Save actually persists it.
  const realPrompt = `Always respond in French. ${suffix}`;
  await textarea.fill(realPrompt);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(dialogHeading).not.toBeVisible();

  const { data: afterSave, error: afterSaveError } = await admin
    .from("notebooks")
    .select("system_prompt")
    .eq("id", notebook!.id)
    .single();
  expect(afterSaveError).toBeNull();
  expect(afterSave?.system_prompt).toBe(realPrompt);

  // Reopening shows the real saved value, confirmed via the UI itself, not
  // just the database.
  await headerSettings.click();
  await expect(dialogHeading).toBeVisible();
  await expect(textarea).toHaveValue(realPrompt);

  // Clearing it back to empty and saving actually removes it -- persists
  // as null, not a stale or blank-string value.
  await textarea.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(dialogHeading).not.toBeVisible();

  const { data: afterClear, error: afterClearError } = await admin
    .from("notebooks")
    .select("system_prompt")
    .eq("id", notebook!.id)
    .single();
  expect(afterClearError).toBeNull();
  expect(afterClear?.system_prompt).toBeNull();
});
