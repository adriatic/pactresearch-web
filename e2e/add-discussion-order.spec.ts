import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { addDiscussionViaRowMenu, chooseRowAction } from "./rowMenuActions";

// Task 60. A newly added discussion must land AFTER the ones already
// there -- and it must do so in the stored order, not only on screen.
//
// Both halves were broken, differently:
//
//   GET /api/discussions ordered created_at DESCENDING, so the Explorer
//   put the newest discussion FIRST.
//
//   The export route had no ORDER BY at all, so its order was whatever
//   Postgres returned -- unstable, and free to disagree with the tree.
//
// This asserts them together, because a display-only fix would leave a
// .pact file ordered differently from the app that produced it.

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
  const email = `e2e-order-${suffix}@example.com`;
  const password = "correct horse battery staple 60!";
  const notebookName = `E2E order notebook ${suffix}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    { email, password, email_confirm: true },
  );
  if (userError || !created.user) throw userError ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();

  // Two existing discussions with distinct, deliberately ordered
  // created_at values, so "after all existing ones" has a meaning that
  // cannot be satisfied by luck.
  const first = `${suffix} aaa-oldest`;
  const second = `${suffix} bbb-middle`;
  await admin.from("discussions").insert([
    {
      notebook_id: notebook!.id,
      user_id: userId,
      name: first,
      created_at: "2026-09-01T10:00:00Z",
    },
    {
      notebook_id: notebook!.id,
      user_id: userId,
      name: second,
      created_at: "2026-09-02T10:00:00Z",
    },
  ]);

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
  return { notebookName, first, second, suffix };
}

test("a discussion added from the row menu lands after the existing ones, in the tree AND in a fresh .pact export", async ({
  page,
  context,
}) => {
  const { notebookName, first, second, suffix } = await seed(page, context);
  const added = `${suffix} zzz-added-last`;

  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });
  // Retried: whether the tree has finished loading when the expand
  // click lands is a race, and a single click can toggle the wrong way.
  const firstRow = page.getByRole("treeitem", { name: first, exact: true });
  await expect(async () => {
    if ((await firstRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(firstRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await addDiscussionViaRowMenu(page, notebookName, added);
  await expect(
    page.getByRole("treeitem", { name: added, exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // 1. In the Explorer. Read the rendered order of this notebook's
  //    discussion rows, rather than trusting that one is "visible".
  // Compared by POSITION rather than by exact row text: a row carries
  // an icon, and a notebook row also carries task 55c's rollup line, so
  // matching whole strings would be asserting the decoration rather
  // than the order.
  const rendered = await page.getByRole("treeitem").allInnerTexts();
  const positionOf = (name: string) =>
    rendered.findIndex((text) => text.includes(name));
  const treeOrder = [first, second, added]
    .map((name) => ({ name, at: positionOf(name) }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.name);

  // All three are actually present -- otherwise the ordering below
  // would be comparing -1s and passing for the wrong reason.
  expect(positionOf(first)).toBeGreaterThanOrEqual(0);
  expect(positionOf(second)).toBeGreaterThanOrEqual(0);
  expect(positionOf(added)).toBeGreaterThanOrEqual(0);
  expect(treeOrder).toEqual([first, second, added]);

  // 2. In a fresh .pact export -- the storage-level half. A
  //    display-only fix would pass the assertion above and fail here.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(notebookRow, notebookName, "Export"),
  ]);
  const exported = JSON.parse(readFileSync((await download.path())!, "utf-8"));
  const exportOrder = exported.discussions.map((d: { name: string }) => d.name);
  expect(exportOrder).toEqual([first, second, added]);

  // 3. And the two agree with each other, which is the property that
  //    actually matters to anyone reading the file later.
  expect(exportOrder).toEqual(treeOrder);
});
