import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 100. The tree's two exports end in lib/saveOrShareFile.ts: the
// share sheet on an iPad or iPhone, the old download everywhere else.
// Runs in both projects. navigator.share/canShare are stubbed in both,
// because no automated browser draws a real share sheet; the stub records
// the file it was handed, and can play "the person tapped Cancel".
//
// - chromium (a Mac's Chrome): the browser *could* share, and the export
//   must still download, exactly as before.
// - webkit-ipad: share sheet with the right file, no download; Cancel
//   leaves no error and no download behind.

const DISCUSSION = "Task 100 discussion";

test.setTimeout(90_000);

function localSupabase() {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
}

async function stubShare(context: BrowserContext, touchPoints: number) {
  await context.addInitScript((points) => {
    const w = window as unknown as {
      __shared: { name: string; type: string; text: string }[];
      __cancelShare: boolean;
    };
    w.__shared = [];
    w.__cancelShare = false;
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      get: () => points,
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { files: File[] }) => {
        const file = data.files[0];
        w.__shared.push({
          name: file.name,
          type: file.type,
          text: await file.text(),
        });
        if (w.__cancelShare) {
          throw new DOMException("Share canceled", "AbortError");
        }
      },
    });
  }, touchPoints);
}

async function seedAndSignIn(page: Page, context: BrowserContext) {
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
    email: `e2e-task100-${suffix}@example.com`,
    password: "correct horse battery staple 100!",
  });
  if (error || !data.user) throw error ?? new Error("no user");
  const notebookName = `T100-${suffix}`;
  const { data: nb, error: nbError } = await client
    .from("notebooks")
    .insert({ user_id: data.user.id, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  if (nbError) throw nbError;
  const { error: dError } = await client
    .from("discussions")
    .insert({ notebook_id: nb.id, user_id: data.user.id, name: DISCUSSION });
  if (dError) throw dError;
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
  return notebookName;
}

function row(page: Page, name: string) {
  return page.getByRole("treeitem", { name, exact: true });
}

async function shared(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __shared: { name: string; text: string }[] })
        .__shared,
  );
}

test("export on the Mac still downloads, even where the browser could share", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop case");
  await stubShare(context, 0);
  const notebookName = await seedAndSignIn(page, context);

  const [pact] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(row(page, notebookName), notebookName, "Export"),
  ]);
  expect(pact.suggestedFilename()).toBe(`${notebookName}.pact`);
  const pactText = readFileSync((await pact.path())!, "utf-8");
  expect(JSON.parse(pactText).version).toBe(1);

  const [md] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(row(page, DISCUSSION), DISCUSSION, "Export"),
  ]);
  expect(md.suggestedFilename()).toMatch(
    /^Task-100-discussion-\d{4}-\d{2}-\d{2}\.md$/,
  );
  expect(readFileSync((await md.path())!, "utf-8")).toMatch(
    new RegExp(`^# ${DISCUSSION}\\n`),
  );

  expect(await shared(page)).toEqual([]);
});

test("export on the iPad opens the share sheet; Cancel leaves nothing behind", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "webkit-ipad", "iPad case");
  await stubShare(context, 5);
  const notebookName = await seedAndSignIn(page, context);
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));

  // Notebook → Export: the .pact file goes to the share sheet.
  await chooseRowAction(row(page, notebookName), notebookName, "Export");
  await expect.poll(async () => (await shared(page)).length).toBe(1);
  let files = await shared(page);
  expect(files[0].name).toBe(`${notebookName}.pact`);
  expect(JSON.parse(files[0].text).version).toBe(1);

  // Discussion → Export: the markdown file, under the server's name.
  await chooseRowAction(row(page, DISCUSSION), DISCUSSION, "Export");
  await expect.poll(async () => (await shared(page)).length).toBe(2);
  files = await shared(page);
  expect(files[1].name).toMatch(/^Task-100-discussion-\d{4}-\d{2}-\d{2}\.md$/);
  expect(files[1].text.startsWith(`# ${DISCUSSION}\n`)).toBe(true);

  // Cancel, for both: no error message, and no download as a fallback.
  await page.evaluate(() => {
    (window as unknown as { __cancelShare: boolean }).__cancelShare = true;
  });
  await chooseRowAction(row(page, notebookName), notebookName, "Export");
  await expect.poll(async () => (await shared(page)).length).toBe(3);
  await chooseRowAction(row(page, DISCUSSION), DISCUSSION, "Export");
  await expect.poll(async () => (await shared(page)).length).toBe(4);

  await page.waitForTimeout(1_000);
  await expect(page.getByText(/Failed to export/)).toHaveCount(0);
  expect(downloads).toEqual([]);
});
