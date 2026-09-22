import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { docToPlainText } from "@/lib/richContent";

// Backward compatibility for discussions that predate the rich-composer
// rebuild: a real discussion seeded with ONLY the legacy plain-text
// draft_prompt_text column (draft_content left null, exactly like every
// discussion already sitting in production before this shipped) must
// still load correctly in the new Tiptap-based composer, with no data
// loss -- including a multi-line draft wrapping into separate paragraphs,
// not collapsing into one run-on line.

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

test.setTimeout(30_000);

test("a discussion with only a legacy draft_prompt_text (no draft_content) loads correctly in the new composer, multi-line intact", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-legacy-draft-${suffix}@example.com`;
  const password = "correct horse battery staple 52!";
  const notebookName = `E2E legacy-draft notebook ${suffix}`;
  const discussionName = `E2E legacy-draft discussion ${suffix}`;
  const legacyDraftLine1 = `legacy line one ${suffix}`;
  const legacyDraftLine2 = `legacy line two ${suffix}`;
  const legacyDraft = `${legacyDraftLine1}\n${legacyDraftLine2}`;

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

  // The pre-rebuild shape exactly: draft_prompt_text set, draft_content
  // untouched (defaults to null) -- simulating a real discussion that
  // existed before this migration/rebuild and was never touched by the
  // new composer.
  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
      draft_prompt_text: legacyDraft,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();
  expect(discussion!.draft_content).toBeNull();

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) existing.value = value;
          else capturedCookies.push({ name, value });
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

  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });
  await discussionRow.click();

  const prompt = page.getByLabel("Prompt");
  // Both lines present, no data loss.
  await expect(prompt).toContainText(legacyDraftLine1);
  await expect(prompt).toContainText(legacyDraftLine2);
  // Genuinely wrapped as two separate paragraphs, not one run-on line --
  // two <p> elements inside the editor, each holding one line.
  await expect(prompt.locator("p")).toHaveCount(2);
  await expect(prompt.locator("p").nth(0)).toHaveText(legacyDraftLine1);
  await expect(prompt.locator("p").nth(1)).toHaveText(legacyDraftLine2);

  // Run is enabled -- the fallback content genuinely counts as non-empty
  // content, same as a real draft would.
  const headerRun = page.locator("header").getByRole("button", { name: "Run" });
  await expect(headerRun).toBeEnabled();

  // Editing it and letting autosave fire migrates this discussion onto
  // draft_content going forward -- draft_prompt_text itself is frozen,
  // never written by the new composer again. Click the end of the
  // second line specifically so the appended text lands there, not at
  // an arbitrary cursor position.
  await prompt.locator("p").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await expect(async () => {
    const { data: row, error } = await admin
      .from("discussions")
      .select("draft_content, draft_prompt_text")
      .eq("id", discussion!.id)
      .single();
    expect(error).toBeNull();
    expect(row!.draft_content).not.toBeNull();
    // docToPlainText joins separate paragraphs with a blank line -- the
    // original single \n between the two legacy lines became two real
    // paragraphs once wrapped by plainTextToDoc, so this reflects that,
    // not the original single-\n string.
    expect(docToPlainText(row!.draft_content)).toBe(
      `${legacyDraftLine1}\n\n${legacyDraftLine2} edited`,
    );
    // The legacy column is untouched -- still exactly what it was seeded
    // with, confirming the PATCH route no longer writes it.
    expect(row!.draft_prompt_text).toBe(legacyDraft);
  }).toPass({ timeout: 3_000 });
});
