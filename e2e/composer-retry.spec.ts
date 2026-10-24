import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { docToPlainText, type RichContent } from "@/lib/richContent";

// Task 35: a "Retry" button on each History entry re-runs that entry's
// own stored prompt_content verbatim -- rich formatting included, no
// edit step -- as a new response appended to the same discussion.
// Reuses /api/execute directly (no new endpoint); the only new client
// logic is useDiscussionExecution.ts's retry(), which sources its
// promptContent from a past PastResponse instead of the composer's
// current draft.
//
// /api/execute is mocked (no ANTHROPIC_API_KEY locally), but the mock
// genuinely inserts its own responses row and returns response_row_id,
// matching the real route -- this exercises the real client-side append
// path, not a client-only illusion.

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

test("Retry re-runs a past entry's exact stored prompt (rich formatting included) without touching the composer's own current draft", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-retry-${suffix}@example.com`;
  const password = "correct horse battery staple 35!";
  const notebookName = `E2E retry notebook ${suffix}`;
  const discussionName = `E2E retry discussion ${suffix}`;

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

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  // Seeded directly -- real rich content (bold text), matching what the
  // Tiptap composer actually produces, not a hand-typed plain string.
  // Retry must resend this exact structure, not a flattened/re-derived
  // version of it.
  const originalPromptContent: RichContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "please answer in " },
          {
            type: "text",
            marks: [{ type: "bold" }],
            text: "bold",
          },
          { type: "text", text: ` ${suffix}` },
        ],
      },
    ],
  };
  const originalPromptText = `please answer in bold ${suffix}`;
  const originalResponseText = `original response ${suffix}`;

  const { error: originalResponseError } = await admin
    .from("responses")
    .insert({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: originalPromptText,
      prompt_content: originalPromptContent,
      response: originalResponseText,
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-mock",
      cell_type: "assistant",
    })
    .select()
    .single();
  expect(originalResponseError).toBeNull();

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

  const retryResponseText = `retried response ${suffix}`;
  let capturedPromptContent: RichContent | undefined;

  await page.route("**/api/execute", async (route) => {
    const body = route.request().postDataJSON() as {
      promptContent: RichContent;
    };
    capturedPromptContent = body.promptContent;

    const { data: inserted, error } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: docToPlainText(body.promptContent),
        prompt_content: body.promptContent,
        response: retryResponseText,
        model: "claude-sonnet-4-6",
        resolved_model: "claude-sonnet-4-6-mock",
        cell_type: "assistant",
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: retryResponseText,
        resolved_model: "claude-sonnet-4-6-mock",
        response_row_id: inserted!.id,
        response_created_at: inserted!.created_at,
      }),
    });
  });

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });

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

  const historySection = page.locator("main");
  await expect(historySection.getByText(originalPromptText)).toBeVisible();
  await expect(historySection.getByText(originalResponseText)).toBeVisible();

  // Types an unsent draft into the composer BEFORE retrying -- Retry
  // must never touch this (unlike pact-mac's own retry(), which
  // cosmetically echoes the retried prompt into the composer; task 35
  // deliberately does not port that side effect).
  const unrelatedDraft = `an unrelated unsent draft ${suffix}`;
  const prompt = page.getByLabel("Prompt");
  await prompt.fill(unrelatedDraft);
  await expect(prompt).toHaveText(unrelatedDraft);

  const retryButton = historySection.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeVisible();
  await expect(retryButton).toBeEnabled();

  // The mocked route above does a real async DB insert before
  // fulfilling, giving a genuine window to observe the in-flight,
  // disabled state below rather than a same-tick race.
  const responsePromise = page.waitForResponse((r) =>
    r.url().includes("/api/execute"),
  );
  await retryButton.click();

  // Disabled the instant the retry fires -- matches the header Run
  // button's own disabled-while-busy gating (execution.loading is
  // shared by run() and retry() alike).
  await expect(retryButton).toBeDisabled();

  await responsePromise;
  // A second History entry (the retried response) now exists with its
  // own Retry button too -- .first() re-scopes rather than tracking a
  // locator that's no longer uniquely one button.
  await expect(
    historySection.getByRole("button", { name: "Retry" }).first(),
  ).toBeEnabled();

  // The composer's own draft is completely untouched by the retry.
  await expect(prompt).toHaveText(unrelatedDraft);

  // The request actually sent to /api/execute carried the ORIGINAL
  // entry's exact stored prompt_content, bold mark and all -- not a
  // flattened/re-typed plain-text version, and not the composer's
  // current (unrelated) draft.
  expect(capturedPromptContent).toEqual(originalPromptContent);

  // The retried response is appended as a NEW entry -- both the original
  // and the retried response are now visible, side by side, in the same
  // discussion's History.
  await expect(historySection.getByText(originalResponseText)).toBeVisible();
  await expect(historySection.getByText(retryResponseText)).toBeVisible();

  const { data: allResponses, error: allResponsesError } = await admin
    .from("responses")
    .select("id, prompt_text, response")
    .eq("discussion_id", discussion!.id)
    .order("created_at", { ascending: true });
  expect(allResponsesError).toBeNull();
  expect(allResponses).toHaveLength(2);
  expect(allResponses![0].response).toBe(originalResponseText);
  expect(allResponses![1].response).toBe(retryResponseText);
  // The retried row's own prompt_text matches the original prompt's
  // plain-text rendering -- confirms the server-side insert (this mock
  // stands in for /api/execute's own real insert) received the same
  // prompt, not something re-derived from the composer.
  expect(allResponses![1].prompt_text).toBe(originalPromptText);
});
