import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 55c. The rollups from 55a/55b, finally on screen.
//
// Two surfaces: the per-notebook total under each Explorer row, and the
// active discussion's "last activity · total" in the status line. The
// assertion that matters most is that the status line changes on EVERY
// switch -- a value fetched once on page load would pass a
// first-impression check and be wrong from the second click onwards.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
}

test.setTimeout(90_000);

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-rollup-ui-${suffix}@example.com`;
  const password = "correct horse battery staple 55!";

  const withData = `E2E rollup measured ${suffix}`;
  const withoutData = `E2E rollup unrun ${suffix}`;
  const busyDiscussion = `E2E rollup busy ${suffix}`;
  const quietDiscussion = `E2E rollup quiet ${suffix}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    { email, password, email_confirm: true },
  );
  if (userError || !created.user) throw userError ?? new Error("no user");
  const userId = created.user.id;

  // Notebook 1: real measured time on one discussion, none on another.
  const { data: nbMeasured } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: withData, category: "Dev Test" })
    .select()
    .single();
  const { data: busy } = await admin
    .from("discussions")
    .insert({
      notebook_id: nbMeasured!.id,
      user_id: userId,
      name: busyDiscussion,
      total_time_ms: 134_000,
    })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: nbMeasured!.id,
    user_id: userId,
    name: quietDiscussion,
    total_time_ms: 0,
  });
  // A run row so runCount is real, not inferred from the total.
  await admin.from("execution_timings").insert({
    user_id: userId,
    discussion_id: busy!.id,
    resolved_model: "claude-sonnet-4-6",
    max_tokens: 1024,
    total_ms: 134_000,
  });

  // Notebook 2: exists, nothing ever run in it.
  const { data: nbEmpty } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: withoutData, category: "Dev Test" })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: nbEmpty!.id,
    user_id: userId,
    name: `E2E rollup never-run ${suffix}`,
    total_time_ms: 0,
  });

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
  return { withData, withoutData, busyDiscussion, quietDiscussion, suffix };
}

// A discussion row only exists once its notebook is expanded. Same
// pattern settings-dialog.spec.ts uses -- retried, because whether the
// tree has finished loading when the click lands is a race.
async function openDiscussion(
  page: Page,
  notebookName: string,
  discussionName: string,
) {
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
  return discussionRow;
}

test("the Explorer shows a measured total for a notebook with runs, and no bare 0s for one without", async ({
  page,
  context,
}) => {
  const { withData, withoutData } = await seed(page, context);

  const measuredRow = page.getByRole("treeitem", {
    name: withData,
    exact: true,
  });
  const unrunRow = page.getByRole("treeitem", {
    name: withoutData,
    exact: true,
  });

  // The rows are still findable by name alone -- the rollup is
  // aria-hidden precisely so it does not join the accessible name.
  await expect(measuredRow).toBeVisible({ timeout: 15_000 });
  await expect(unrunRow).toBeVisible();

  await expect(measuredRow).toContainText("2m 14s", { timeout: 15_000 });
  await expect(unrunRow).toContainText("No runs yet", { timeout: 15_000 });

  // The rule this task exists for.
  await expect(unrunRow).not.toContainText("0s");
});

test("the status line shows the active discussion's rollup, and updates on EVERY switch", async ({
  page,
  context,
}) => {
  const { withData, busyDiscussion, quietDiscussion } = await seed(
    page,
    context,
  );

  const statusLine = page.getByRole("group", { name: "Active discussion" });

  await openDiscussion(page, withData, busyDiscussion);
  await expect(statusLine).toContainText(busyDiscussion, { timeout: 15_000 });
  await expect(statusLine).toContainText("2m 14s", { timeout: 15_000 });
  await expect(statusLine).toContainText("Last activity", { timeout: 15_000 });

  // The switch is the point: a value fetched once on load would still
  // read "2m 14s" here.
  await page
    .getByRole("treeitem", { name: quietDiscussion, exact: true })
    .click();
  await expect(statusLine).toContainText(quietDiscussion, { timeout: 15_000 });
  await expect(statusLine).toContainText("No runs yet", { timeout: 15_000 });
  await expect(statusLine).not.toContainText("2m 14s");

  // And back again -- it has to re-derive, not just change once.
  await page
    .getByRole("treeitem", { name: busyDiscussion, exact: true })
    .click();
  await expect(statusLine).toContainText("2m 14s", { timeout: 15_000 });
  await expect(statusLine).not.toContainText("No runs yet");
});

// Produces the screenshots the task asks for, showing one notebook with
// data and one without. Assertion-light on purpose: the behaviour is
// covered above; this exists so the result can be eyeballed.
test("screenshot: Explorer rollups and status line", async ({
  page,
  context,
}, testInfo) => {
  const { withData, busyDiscussion } = await seed(page, context);
  await openDiscussion(page, withData, busyDiscussion);
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText("2m 14s", { timeout: 15_000 });

  const shots: [string, Buffer][] = [
    [
      "explorer-rollups.png",
      await page.locator("section").first().screenshot(),
    ],
    [
      "status-line-rollup.png",
      await page.getByRole("group", { name: "Active discussion" }).screenshot(),
    ],
    ["full-page-rollups.png", await page.screenshot()],
  ];
  for (const [name, body] of shots) {
    await testInfo.attach(name, { body, contentType: "image/png" });
    const dir = process.env.ROLLUP_SHOTS_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
    }
  }
  expect(withData.length).toBeGreaterThan(0);
});
