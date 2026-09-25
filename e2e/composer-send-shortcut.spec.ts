import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { docToPlainText, type RichContent } from "@/lib/richContent";

// Task 43 item 1: Cmd+Enter (Ctrl+Enter off Apple) submits the composer,
// matching pact-mac's own binding.
//
// The scoping assertion at the end is the point of this file, not a
// bonus. Task 39 deliberately avoided a document-level keydown listener
// for its own trigger, citing task 36's history: an ancestor-level
// handler swallowing keystrokes before ProseMirror saw them was a real,
// hard-to-diagnose bug in this exact composer. This shortcut is a
// ProseMirror keymap on the editor, so it must be inert when the editor
// does not have focus -- and that is what pins it as a keymap rather
// than something hand-rolled on window/document later.
//
// /api/execute is mocked at the browser network layer, same as
// header-run-button.spec.ts: no ANTHROPIC_API_KEY locally, and the client
// path exercised is identical either way.

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

test("Cmd/Ctrl+Enter submits the composer, is gated like Run, and only fires from the editor", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-send-shortcut-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const discussionName = `E2E shortcut discussion ${suffix}`;

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
    .insert({ user_id: userId, name: `E2E shortcut notebook ${suffix}` })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { error: discussionError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });
  expect(discussionError).toBeNull();

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

  let executeCalls = 0;
  let executedPromptText: string | null = null;
  await page.route("**/api/execute", async (route) => {
    executeCalls += 1;
    const body = route.request().postDataJSON() as {
      promptContent?: RichContent;
    };
    executedPromptText = body.promptContent
      ? docToPlainText(body.promptContent)
      : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: "# Sent by shortcut\n\nIt **worked**.",
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();

  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();

  // --- inert when the run gate is closed (empty composer) ---
  await prompt.fill("");
  await prompt.press("ControlOrMeta+Enter");
  expect(executeCalls).toBe(0);

  // --- and it must not have inserted a paragraph break instead ---
  expect((await prompt.innerText()).trim()).toBe("");

  // --- inert when the editor does not have focus ---
  // The header Run button is a deliberate choice of focus target: it is a
  // real, focusable control outside the editor, so this proves the keymap
  // is bound to the editor rather than to the document.
  const promptText = `shortcut prompt ${suffix}`;
  await prompt.fill(promptText);
  const headerRun = page.locator("header").getByRole("button", { name: "Run" });
  await expect(headerRun).toBeEnabled();
  await headerRun.focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  expect(executeCalls).toBe(0);

  // --- fires from the editor, with that discussion's own text ---
  await prompt.click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    prompt.press("ControlOrMeta+Enter"),
  ]);
  expect(executeCalls).toBe(1);
  expect(executedPromptText).toBe(promptText);

  // The run it started is a real one: same disabled-while-running state
  // the Run button drives.
  await expect(page.locator("main")).toContainText("Sent by shortcut");
});
