import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 44 item A, reported by Nik and reproducible by hand: in a notebook
// that already has a discussion with prior runs, create a NEW discussion
// and switch to it -- the composer shows the previous discussion's prompt
// text instead of being empty.

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

test("a brand-new discussion in a notebook with prior runs opens with an empty composer", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-stale-composer-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const notebookName = `E2E stale notebook ${suffix}`;
  const oldDiscussionName = `E2E old discussion ${suffix}`;
  const newDiscussionName = `E2E new discussion ${suffix}`;
  const priorPrompt = `PRIOR RUN PROMPT ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: oldDiscussion, error: oldErr } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: oldDiscussionName,
    })
    .select()
    .single();
  expect(oldErr).toBeNull();

  // A prior RUN, not a draft. This is what makes the composer non-empty
  // on the old discussion: the switch-load falls back to the most recent
  // cell's own prompt when there is no unsent draft.
  const { error: respErr } = await admin.from("responses").insert({
    discussion_id: oldDiscussion!.id,
    user_id: userId,
    prompt_text: priorPrompt,
    response: "a prior response",
    resolved_model: "claude-sonnet-4-6-mock",
  });
  expect(respErr).toBeNull();

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

  const prompt = page.getByLabel("Prompt");

  // Select the old discussion so its prior prompt is what the composer
  // is showing at the moment the new discussion gets created.
  await page.getByRole("treeitem", { name: oldDiscussionName }).click();
  await expect(prompt).toHaveText(priorPrompt, { timeout: 15_000 });

  // Create a new discussion in that same notebook, exactly as the UI does.
  await page.getByLabel("Name:").nth(1).fill(newDiscussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: newDiscussionName }),
  ).toBeVisible({ timeout: 15_000 });

  // Creation switches to it. The composer must be empty.
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(newDiscussionName, { timeout: 15_000 });
  await expect(prompt).toHaveText("", { timeout: 15_000 });

  // And it must stay empty -- not be emptied and then refilled by a
  // late-resolving load, nor refill after an explicit switch away and back.
  await page.waitForTimeout(1500);
  await expect(prompt).toHaveText("");

  await page.getByRole("treeitem", { name: oldDiscussionName }).click();
  await expect(prompt).toHaveText(priorPrompt, { timeout: 15_000 });
  await page.getByRole("treeitem", { name: newDiscussionName }).click();
  await expect(prompt).toHaveText("", { timeout: 15_000 });
});
