import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Task 98. Refine with AI in the New Notebook dialog: one-shot, the same
// route as Settings, the draft going into the System prompt field.
//
// Each test signs up an ordinary user with the local database's public
// (anon) key and seeds with that user's own session. The user has no
// Anthropic key, so where a draft is needed /api/refine-system-prompt is
// answered in the browser (as Settings' spec does); the missing-key and
// run-lock tests use the real route, which answers without a key.

const MISSING_KEY_TEXT =
  "Refine with AI needs your Anthropic API key. Add it in Account → Keys, " +
  "then try again. Nothing was sent.";

test.setTimeout(90_000);

function localSupabase() {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
}

async function signUp(
  page: Page,
  context: BrowserContext,
): Promise<{ client: SupabaseClient; userId: string; suffix: string }> {
  const { API_URL, ANON_KEY } = localSupabase();
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
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await client.auth.signUp({
    email: `e2e-task98-${suffix}@example.com`,
    password: "correct horse battery staple 98!",
  });
  if (error || !data.user) throw error ?? new Error("no user");
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
  return { client, userId: data.user.id, suffix };
}

async function openApp(page: Page) {
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
}

async function openNewNotebook(page: Page) {
  await page
    .locator("header")
    .getByRole("button", { name: "New Notebook" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function refineLine(dialog: ReturnType<Page["getByRole"]>) {
  return dialog.getByPlaceholder("Describe your research domain...");
}

// Answers Refine in the browser with `draft` for each call, in order.
async function answerRefine(page: Page, drafts: string[]) {
  const sent: string[] = [];
  await page.route("**/api/refine-system-prompt", async (route) => {
    sent.push(
      (route.request().postDataJSON() as { description: string }).description,
    );
    const draft = drafts[Math.min(sent.length - 1, drafts.length - 1)];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ systemPrompt: draft }),
    });
  });
  return sent;
}

test("a draft fills an empty System prompt field; edited, it is the notebook's prompt in Settings", async ({
  page,
  context,
}) => {
  const { client, suffix } = await signUp(page, context);
  const drafted = `You are reviewing oncology trial protocols. ${suffix}`;
  const sent = await answerRefine(page, [drafted]);
  await openApp(page);

  const dialog = await openNewNotebook(page);
  const systemPrompt = dialog.getByLabel("System prompt:");

  // Above the System prompt field, as decided.
  const lineBox = await refineLine(dialog).boundingBox();
  const fieldBox = await systemPrompt.boundingBox();
  expect(lineBox!.y).toBeLessThan(fieldBox!.y);

  // Enter sends, as the arrow does.
  await refineLine(dialog).fill("Oncology trial protocol review");
  await refineLine(dialog).press("Enter");
  await expect(systemPrompt).toHaveValue(drafted);
  expect(sent).toEqual(["Oncology trial protocol review"]);
  await expect(dialog.getByText(/Replace it with the draft/)).toHaveCount(0);

  // Edited freely, then Create, as today.
  const edited = `${drafted} Cite the protocol section.`;
  await systemPrompt.fill(edited);
  const name = `E2E task 98 ${suffix}`;
  await dialog.getByLabel("Name:").fill(name);
  await dialog
    .getByLabel("Research question:")
    .fill("Which endpoints are reported?");
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(dialog).toBeHidden();

  // Stored as edited, and Settings shows it.
  const { data: rows } = await client
    .from("notebooks")
    .select("system_prompt")
    .eq("name", name);
  expect(rows).toEqual([{ system_prompt: edited }]);
  const settingsButton = page
    .locator("header")
    .getByRole("button", { name: "Settings" });
  await expect(settingsButton).toBeEnabled({ timeout: 15_000 });
  await settingsButton.click();
  await expect(
    page.getByRole("heading", { name: "Notebook settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("System prompt:")).toHaveValue(edited);
});

test("own text in the field: Replace / Keep, and a field still holding the last draft is replaced without asking", async ({
  page,
  context,
}) => {
  await signUp(page, context);
  const first = "You are a first draft.";
  const second = "You are a second draft.";
  const third = "You are a third draft.";
  await answerRefine(page, [first, second, third]);
  await openApp(page);

  const dialog = await openNewNotebook(page);
  const systemPrompt = dialog.getByLabel("System prompt:");
  const send = dialog.getByRole("button", { name: "Send" });
  const question = dialog.getByText(/Replace it with the draft/);
  const mine = "My own instructions, typed by hand.";

  // Keep: the field stays as typed and the draft is dropped.
  await systemPrompt.fill(mine);
  await refineLine(dialog).fill("Pharmacology");
  await send.click();
  await expect(question).toBeVisible();
  await expect(systemPrompt).toHaveValue(mine);
  await dialog.getByRole("button", { name: "Keep my text" }).click();
  await expect(question).toHaveCount(0);
  await expect(systemPrompt).toHaveValue(mine);

  // Replace: the draft goes in.
  await refineLine(dialog).fill("Pharmacology, drug interactions");
  await send.click();
  await expect(question).toBeVisible();
  await dialog.getByRole("button", { name: "Replace my text" }).click();
  await expect(question).toHaveCount(0);
  await expect(systemPrompt).toHaveValue(second);

  // The field still holds exactly that draft: the next one fills it
  // without asking.
  await refineLine(dialog).fill("Pharmacology, paediatric dosing");
  await send.click();
  await expect(systemPrompt).toHaveValue(third);
  await expect(question).toHaveCount(0);
});

test("no Anthropic key: a message made for Refine, and the field is untouched", async ({
  page,
  context,
}) => {
  await signUp(page, context);
  await openApp(page);

  const dialog = await openNewNotebook(page);
  await dialog.getByLabel("System prompt:").fill("Already here.");
  await refineLine(dialog).fill("Oncology");
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/refine-system-prompt")),
    dialog.getByRole("button", { name: "Send" }).click(),
  ]);

  // The real route stops at the key check, before any call to Anthropic.
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe("missing_anthropic_key");
  await expect(dialog.getByText(MISSING_KEY_TEXT)).toBeVisible();
  await expect(dialog.getByText(/before running prompts/)).toHaveCount(0);
  await expect(dialog.getByLabel("System prompt:")).toHaveValue(
    "Already here.",
  );
});

test("waiting state, no double send, and an answer after closing never reaches a later dialog", async ({
  page,
  context,
}) => {
  await signUp(page, context);
  let calls = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let answered!: () => void;
  const wasAnswered = new Promise<void>((resolve) => (answered = resolve));
  await page.route("**/api/refine-system-prompt", async (route) => {
    calls += 1;
    await released;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ systemPrompt: "You are a late draft." }),
    });
    answered();
  });
  await openApp(page);

  const dialog = await openNewNotebook(page);
  const send = dialog.getByRole("button", { name: "Send" });
  await refineLine(dialog).fill("Oncology");
  await send.click();

  // Waiting: said plainly, and neither the arrow nor Enter sends again.
  await expect(dialog.getByText("Drafting a system prompt…")).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(refineLine(dialog)).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(calls).toBe(1);

  // Closed while waiting, then opened again.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const again = await openNewNotebook(page);

  // The late answer arrives now; nothing of it shows.
  release();
  await wasAnswered;
  await page.waitForTimeout(500);
  await expect(again.getByLabel("System prompt:")).toHaveValue("");
  await expect(again.getByText(/Replace it with the draft/)).toHaveCount(0);
  await expect(again.getByText("Drafting a system prompt…")).toHaveCount(0);
  await expect(refineLine(again)).toBeEnabled();
  expect(calls).toBe(1);
});

test("Refine works while a run is streaming, takes no run lock, and writes nothing", async ({
  page,
  context,
}) => {
  const { client, userId, suffix } = await signUp(page, context);
  const notebookName = `E2E task 98 run ${suffix}`;
  const discussionName = `Run ${suffix}`;
  const { data: nb, error: nbError } = await client
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  if (nbError) throw nbError;
  const { data: discussion, error: dError } = await client
    .from("discussions")
    .insert({ notebook_id: nb.id, user_id: userId, name: discussionName })
    .select()
    .single();
  if (dError) throw dError;

  // A run in flight in the app: /api/execute is held open.
  let runStarted!: () => void;
  const started = new Promise<void>((resolve) => (runStarted = resolve));
  let finishRun!: () => void;
  const runFinished = new Promise<void>((resolve) => (finishRun = resolve));
  await page.route("**/api/execute", async (route) => {
    runStarted();
    await runFinished;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: "Done.",
        resolved_model: "claude-sonnet-5-mock",
      }),
    });
  });
  const drafted = `You are drafted during a run. ${suffix}`;
  await answerRefine(page, [drafted]);
  await openApp(page);

  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const discussionRow = page.getByRole("treeitem", {
    name: discussionName,
    exact: true,
  });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await prompt.click();
  await page.keyboard.type("A prompt that keeps running.");
  await page
    .locator("header")
    .getByRole("button", { name: "Run", exact: true })
    .click();
  await started;

  // During the run: Refine drafts as usual.
  const dialog = await openNewNotebook(page);
  await refineLine(dialog).fill("Oncology");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByLabel("System prompt:")).toHaveValue(drafted);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  finishRun();

  // The real route with the user's run lock really held: it answers with
  // its own reply (here, the missing key), not "already in progress".
  const { data: acquired, error: lockError } = await client.rpc(
    "try_acquire_execution_lock",
    { p_user_id: userId, p_discussion_id: discussion.id },
  );
  expect(lockError).toBeNull();
  expect(acquired).toBe(true);
  await page.unroute("**/api/refine-system-prompt");
  const refineDuringLock = await page.evaluate(async () => {
    const r = await fetch("/api/refine-system-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Oncology" }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(refineDuringLock.status).toBe(400);
  expect(refineDuringLock.body.code).toBe("missing_anthropic_key");

  // Nothing was written: still the one notebook, its prompt unset.
  const { data: notebooks } = await client
    .from("notebooks")
    .select("name, system_prompt");
  expect(notebooks).toEqual([{ name: notebookName, system_prompt: null }]);
});
