import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 77. Older .pact files -- signed exports from the VSCode extension
// (pact-local) and the legacy app (pactresearch.net), and the plain
// variants pact-mac and early pact-web wrote -- go through the real Import
// button and open in the app. Fixtures keep the real files' structure
// with synthetic content (see __tests__/fixtures/pact-older).

const FIXTURES = join(__dirname, "..", "__tests__", "fixtures", "pact-older");

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

async function signIn(
  page: Page,
  context: BrowserContext,
): Promise<{ admin: SupabaseClient; userId: string }> {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-pact-older-${suffix}@example.com`;
  const password = "correct horse battery staple 77!";
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
  return { admin, userId: created.user.id };
}

async function importFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type="file"][accept=".pact"]').setInputFiles({
    name,
    mimeType: "application/json",
    buffer,
  });
}

const fixture = (name: string) => readFileSync(join(FIXTURES, name));

async function notebookCount(admin: SupabaseClient, userId: string) {
  const { count } = await admin
    .from("notebooks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count;
}

// Expands the imported notebook (it arrives collapsed), opens a
// discussion, and checks its first response renders.
async function openAndSeeResponse(
  page: Page,
  notebook: string,
  discussion: string,
) {
  const notebookRow = page.getByRole("treeitem", {
    name: notebook,
    exact: true,
  });
  const discussionRow = page.getByRole("treeitem", {
    name: discussion,
    exact: true,
  });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussion);
  await expect(
    page.locator("main").getByText("Synthetic response 1.").first(),
  ).toBeVisible({ timeout: 15_000 });
}

test("a signed export from the VSCode extension imports, opens, and says what it left behind", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  await importFile(
    page,
    "extension.pact",
    fixture("signed-pact-local-with-xmstate.pact"),
  );

  await expect(
    page.getByRole("treeitem", {
      name: "Fixture signed extension notebook",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  const notice = page.locator("[data-import-notice]");
  await expect(notice).toContainText("signed by pact-local");
  await expect(notice).toContainText("xmState");
  await expect(notice).toContainText('executionMode ("index")');

  await openAndSeeResponse(page, "Fixture signed extension notebook", "Alpha");
});

test("a signed export from the legacy app imports and opens", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  await importFile(
    page,
    "legacy.pact",
    fixture("signed-pactresearch-net.pact"),
  );
  await expect(
    page.getByRole("treeitem", {
      name: "Fixture legacy app notebook",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-import-notice]")).toContainText(
    "signed by pactresearch.net",
  );
  await openAndSeeResponse(page, "Fixture legacy app notebook", "Gamma");
});

for (const [file, notebook, discussion] of [
  ["plain-pact-mac-category-mode.pact", "Fixture pact-mac notebook", "Delta"],
  [
    "plain-old-gpt-parent-chain.pact",
    "Fixture old chained notebook",
    "Epsilon",
  ],
  ["plain-old-minimal.pact", "Fixture old minimal notebook", "Zeta"],
] as const) {
  test(`older plain file ${file} imports and opens`, async ({
    page,
    context,
  }) => {
    await signIn(page, context);
    await importFile(page, file, fixture(file));
    await expect(
      page.getByRole("treeitem", { name: notebook, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/isn't valid|Failed to import/i)).toHaveCount(
      0,
    );
    await openAndSeeResponse(page, notebook, discussion);
  });
}

test("a truncated file is refused clearly and creates nothing", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await importFile(page, "truncated.pact", fixture("truncated.pact"));
  await expect(page.getByText(/may be truncated/)).toBeVisible();
  expect(await notebookCount(admin, userId)).toBe(0);
});

test("JSON that is not a .pact file is refused clearly and creates nothing", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await importFile(page, "other.json.pact", Buffer.from('{"hello":"world"}'));
  await expect(page.getByText("Not a .pact file")).toBeVisible();
  expect(await notebookCount(admin, userId)).toBe(0);
});

test("an import that fails partway leaves no half-imported notebook", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  // Valid enough to pass the reader, but its last cell's timestamp is not
  // a representable date -- the notebook and discussions are written
  // before the cells fail.
  const file = JSON.parse(
    fixture("plain-old-minimal.pact").toString("utf8"),
  ) as { cells: { createdAt: number }[] };
  file.cells[file.cells.length - 1].createdAt = 1e20;

  await importFile(page, "corrupt.pact", Buffer.from(JSON.stringify(file)));

  await expect(page.locator("header")).toContainText(/error|wrong|failed/i, {
    timeout: 15_000,
  });
  expect(await notebookCount(admin, userId)).toBe(0);
  const { count: discussions } = await admin
    .from("discussions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  expect(discussions).toBe(0);
});
