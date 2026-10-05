import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 77. Files produced by the one-time converter (tools/pact-convert)
// go through pact-web's own, unchanged importer and open in the app. The
// importer accepts only the current format; the converter is what makes
// older files fit it.
//
// Delete this file together with tools/pact-convert (see its README).

const FIXTURES = join(__dirname, "..", "tools", "pact-convert", "fixtures");

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

async function signIn(page: Page, context: BrowserContext): Promise<void> {
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
}

async function importFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type="file"][accept=".pact"]').setInputFiles({
    name,
    mimeType: "application/json",
    buffer,
  });
}

const fixture = (name: string) => readFileSync(join(FIXTURES, name));

// Runs the converter's real command line on a fixture (optionally edited)
// and returns the file it wrote -- converted, or copied unchanged when the
// fixture was already current.
const CONVERTER = join(__dirname, "..", "tools", "pact-convert", "convert.mjs");
function converted(
  name: string,
  edit?: (file: { cells: { response: string }[] }) => void,
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pact-convert-e2e-"));
  const input = join(dir, "in", name);
  mkdirSync(join(dir, "in"));
  let text = fixture(name).toString("utf8");
  if (edit) {
    const file = JSON.parse(text);
    edit(file);
    text = JSON.stringify(file);
  }
  writeFileSync(input, text);
  execFileSync("node", [CONVERTER, "--out", join(dir, "out"), input]);
  return readFileSync(join(dir, "out", name));
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

for (const [file, notebook, discussion] of [
  [
    "signed-pact-local-with-xmstate.pact",
    "Fixture signed extension notebook",
    "Alpha",
  ],
  ["signed-pactresearch-net.pact", "Fixture legacy app notebook", "Gamma"],
  ["plain-pact-mac-category-mode.pact", "Fixture pact-mac notebook", "Delta"],
  [
    "plain-old-gpt-parent-chain.pact",
    "Fixture old chained notebook",
    "Epsilon",
  ],
  ["plain-old-minimal.pact", "Fixture old minimal notebook", "Zeta"],
] as const) {
  test(`converted ${file} imports through the current importer and opens`, async ({
    page,
    context,
  }) => {
    await signIn(page, context);
    await importFile(page, file, converted(file));
    await expect(
      page.getByRole("treeitem", { name: notebook, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/isn't valid|Failed to import|Unsupported/i),
    ).toHaveCount(0);
    await openAndSeeResponse(page, notebook, discussion);
  });
}

test("a converted prompt that was never run reads as never run, not as an empty response", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  await importFile(
    page,
    "unrun.pact",
    converted("plain-old-minimal.pact", (file) => {
      // Zeta's only prompt, never run in the app that exported it.
      file.cells[0].response = "";
    }),
  );
  const notebookRow = page.getByRole("treeitem", {
    name: "Fixture old minimal notebook",
    exact: true,
  });
  const zeta = page.getByRole("treeitem", { name: "Zeta", exact: true });
  await expect(async () => {
    if ((await zeta.count()) === 0) await notebookRow.locator("h3").click();
    await expect(zeta).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await zeta.click();
  await expect(
    page.locator("main").getByText("No response — this prompt was never run."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("main").getByRole("button", { name: "Continue" }),
  ).toHaveCount(0);
});

// Reported, not changed (Task 77): importing the same converted file twice
// creates a second, independent notebook with a suffixed name.
test("importing the same converted file twice creates a second notebook", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  const file = converted("signed-pactresearch-net.pact");
  await importFile(page, "legacy.pact", file);
  await expect(
    page.getByRole("treeitem", {
      name: "Fixture legacy app notebook",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await importFile(page, "legacy.pact", file);
  await expect(
    page.getByRole("treeitem", {
      name: "Fixture legacy app notebook 1",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
});
