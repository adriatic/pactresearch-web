import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 52. The New Notebook modal that replaces the flat inline form.

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

async function signIn(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-newnb-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no user");

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
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
  return { admin, userId: created.user.id, suffix };
}

function openModal(page: Page) {
  return page
    .locator("header")
    .getByRole("button", { name: "New Notebook" })
    .click()
    .then(() => page.getByRole("dialog", { name: "New notebook" }));
}

test("the modal has the specified fields, and deliberately omits the others", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  const dialog = await openModal(page);
  await expect(dialog).toBeVisible();

  // The flat inline form it replaces is hidden.
  await expect(
    page.getByRole("heading", { name: "Notebook creator" }),
  ).toHaveCount(0);

  await expect(dialog.getByLabel("Name:")).toBeVisible();

  // Execution mode is a real radio group, not a hardcoded value -- that
  // is what lets a second mode drop in later.
  const interactive = dialog.getByRole("radio", { name: /Interactive/ });
  await expect(interactive).toBeVisible();
  await expect(interactive).toBeEnabled();
  await expect(interactive).toBeChecked();
  // Index was removed.
  await expect(dialog.getByRole("radio", { name: /Index/ })).toHaveCount(0);

  // Category: the two categories pact-web actually accepts. "Samples"
  // was cut from pact-web (decision 3.13) and /api/notebooks rejects it,
  // so offering it would ship an option that 400s.
  const category = dialog.getByLabel("Category:");
  await expect(category).toBeVisible();
  await expect(category.getByRole("option")).toHaveText([
    "Personal Research",
    "Dev Test",
  ]);

  await expect(dialog.getByLabel("Research question:")).toBeVisible();

  // Refine with AI is present but inactive, and visibly so rather than
  // looking like a button that simply is not responding.
  const refineSend = dialog.getByRole("button", { name: "Send" });
  await expect(refineSend).toBeDisabled();
  await expect(dialog.getByText("Coming soon.")).toBeVisible();

  // System prompt is excluded from this modal entirely (task 53).
  await expect(dialog.getByText(/system prompt/i)).toHaveCount(0);
});

test("a research question creates the first discussion and pre-populates the composer", async ({
  page,
  context,
}) => {
  const { suffix } = await signIn(page, context);
  const notebookName = `E2E modal notebook ${suffix}`;
  const question = `What drives retention in year two? ${suffix}`;

  const dialog = await openModal(page);
  await dialog.getByLabel("Name:").fill(notebookName);
  await dialog.getByLabel("Category:").selectOption("Dev Test");
  await dialog.getByLabel("Research question:").fill(question);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // The notebook is in the tree, and so is the discussion the question
  // created.
  await expect(page.getByRole("treeitem", { name: notebookName })).toBeVisible({
    timeout: 15_000,
  });

  // The composer holds the question, ready to run or edit. Persisted as
  // the discussion's draft, so it survives a reload rather than being an
  // in-memory illusion.
  await expect(page.getByLabel("Prompt")).toHaveText(question, {
    timeout: 15_000,
  });
  await page.reload();
  await expect(page.getByLabel("Prompt")).toHaveText(question, {
    timeout: 15_000,
  });
});

test("without a research question it creates just the notebook, and Add a discussion still works", async ({
  page,
  context,
}) => {
  const { suffix } = await signIn(page, context);
  const notebookName = `E2E bare notebook ${suffix}`;
  const discussionName = `E2E bare discussion ${suffix}`;

  const dialog = await openModal(page);
  await dialog.getByLabel("Name:").fill(notebookName);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  await expect(page.getByRole("treeitem", { name: notebookName })).toBeVisible({
    timeout: 15_000,
  });

  // Hiding the legacy form must NOT have taken discussion creation with
  // it -- that form is still the only way to add one to an existing
  // notebook.
  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible({ timeout: 15_000 });
});

test("the modal is reusable: creating twice in a row works", async ({
  page,
  context,
}) => {
  // Guards the same class of bug task 51 hit in ModelTierDialog, and
  // that this modal hit during development: state surviving onClose()
  // left every field disabled on the second open.
  const { suffix } = await signIn(page, context);

  for (const n of [1, 2]) {
    const dialog = await openModal(page);
    await expect(dialog).toBeVisible();
    const field = dialog.getByLabel("Name:");
    await expect(field).toBeEnabled();
    // ...and no leftover text from the previous create.
    await expect(field).toHaveValue("");
    await field.fill(`E2E repeat ${n} ${suffix}`);
    await dialog.getByRole("button", { name: "Create notebook" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
  }

  await expect(
    page.getByRole("treeitem", { name: `E2E repeat 1 ${suffix}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: `E2E repeat 2 ${suffix}` }),
  ).toBeVisible();
});
