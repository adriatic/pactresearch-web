import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { docToPlainText, type RichContent } from "@/lib/richContent";

// Task 34: Retry, ported from pact-mac's task 32 audit. Re-runs a past
// History entry's own original prompt content verbatim, as a new
// response appended to the same discussion -- no edit step, and
// deliberately never touching the composer's own current draft (unlike
// pact-mac's own version, which cosmetically overwrites the composer
// with the retried text -- see useDiscussionExecution.ts's retry() for
// why that wasn't ported here).
//
// /api/execute is mocked (no ANTHROPIC_API_KEY locally), same pattern as
// history-live-append.spec.ts -- each mock genuinely inserts its own
// responses row and returns response_row_id pointing at it, so this
// exercises the real append path, not a client-only illusion.

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

test("Retry resends the exact original prompt verbatim as a new response, without touching the composer's current draft", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-history-retry-${suffix}@example.com`;
  const password = "correct horse battery staple 37!";
  const notebookName = `E2E history-retry notebook ${suffix}`;
  const discussionName = `E2E history-retry discussion ${suffix}`;

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

  const originalPrompt = `retry me ${suffix}`;
  const firstResponse = `original response ${suffix}`;
  const retriedResponse = `retried response ${suffix}`;

  let executeCallCount = 0;
  const capturedPromptContents: RichContent[] = [];

  await page.route("**/api/execute", async (route) => {
    const body = route.request().postDataJSON() as {
      promptContent: RichContent;
    };
    capturedPromptContents.push(body.promptContent);
    executeCallCount += 1;
    const isRetry = executeCallCount === 2;
    const responseText = isRetry ? retriedResponse : firstResponse;

    const { data: inserted, error } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: docToPlainText(body.promptContent),
        prompt_content: body.promptContent,
        response: responseText,
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
        response: responseText,
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

  const prompt = page.getByLabel("Prompt");
  const runButton = page.locator("header").getByRole("button", { name: "Run" });

  // Original run.
  await prompt.fill(originalPrompt);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);
  await expect(page.locator("main").getByText(firstResponse)).toBeVisible();

  // A real, unsent draft sitting in the composer right now -- retry must
  // not touch this in any way (unlike pact-mac's own version, which
  // cosmetically overwrites the composer with the retried text).
  const unrelatedDraft = `unrelated draft, do not touch ${suffix}`;
  await prompt.fill(unrelatedDraft);
  await expect(prompt).toHaveText(unrelatedDraft);

  const retryButton = page.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeEnabled();

  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    retryButton.click(),
  ]);

  // The retried response is appended as a *second*, new entry -- the
  // original entry's own prompt/response both remain visible too, not
  // replaced.
  const historySection = page.locator("main");
  await expect(historySection.getByText(firstResponse)).toBeVisible();
  await expect(historySection.getByText(retriedResponse)).toBeVisible();
  await expect(historySection.getByText(originalPrompt)).toHaveCount(2);

  // The exact original prompt content was resent, verbatim -- not
  // whatever the composer happened to show at retry time (which by now
  // holds unrelatedDraft, confirmed above).
  expect(executeCallCount).toBe(2);
  expect(capturedPromptContents[1]).toEqual(capturedPromptContents[0]);

  // Retry must not have touched the composer's own current draft.
  await expect(prompt).toHaveText(unrelatedDraft);
});

test("Retry is disabled while an execution is already in progress", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-history-retry-lock-${suffix}@example.com`;
  const password = "correct horse battery staple 37b!";
  const notebookName = `E2E history-retry-lock notebook ${suffix}`;
  const discussionName = `E2E history-retry-lock discussion ${suffix}`;

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

  const originalPrompt = `lock test prompt ${suffix}`;
  const firstResponse = `lock test response ${suffix}`;

  let executeCallCount = 0;

  await page.route("**/api/execute", async (route) => {
    executeCallCount += 1;
    if (executeCallCount === 2) {
      // The retry click itself, held open long enough to observe the
      // button's own disabled state mid-flight.
      await new Promise((r) => setTimeout(r, 1500));
    }
    const { data: inserted, error } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: originalPrompt,
        prompt_content: (
          route.request().postDataJSON() as { promptContent: RichContent }
        ).promptContent,
        response: firstResponse,
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
        response: firstResponse,
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

  const prompt = page.getByLabel("Prompt");
  const runButton = page.locator("header").getByRole("button", { name: "Run" });

  await prompt.fill(originalPrompt);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    runButton.click(),
  ]);
  await expect(page.locator("main").getByText(firstResponse)).toBeVisible();

  const retryButton = page.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeEnabled();

  // Fire the retry (which the mock holds open for 1.5s) and, while it's
  // still in flight, confirm both Run and Retry are disabled -- matching
  // exactly the same execution.loading guard the header's own Run button
  // already uses.
  await retryButton.click();
  await expect(runButton).toBeDisabled();
  await expect(retryButton).toBeDisabled();

  // A second Retry button now exists too, once the in-flight retry's own
  // response is appended as a new history entry -- scope to .first() so
  // this assertion isn't ambiguous about which one re-enabled.
  await expect(retryButton.first()).toBeEnabled({ timeout: 5_000 });
});
