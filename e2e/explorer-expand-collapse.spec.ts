import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the real tree-view control (headless-tree) added to replace
// the hand-rolled "▼"/"▶" text-triangle: clicking a collapsed notebook
// row expands it and reveals its discussions, clicking again collapses
// it and hides them — through the actual rendered ARIA tree, not by
// reaching into component internals.

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

test("clicking a notebook row expands and collapses it, showing and hiding its discussions", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-expand-collapse-${suffix}@example.com`;
  const password = "correct horse battery staple 11!";
  const collapsedNotebookName = `E2E collapsed notebook ${suffix}`;
  const collapsedDiscussionName = `E2E collapsed discussion ${suffix}`;
  const activeNotebookName = `E2E active notebook ${suffix}`;
  const activeDiscussionName = `E2E active discussion ${suffix}`;

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

  // Created first, so it's not the most recent discussion — its notebook
  // does not get auto-expanded, giving a genuine collapsed-by-default row
  // to test the click-to-expand/collapse control on.
  const { data: collapsedNotebook, error: collapsedNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: collapsedNotebookName })
    .select()
    .single();
  expect(collapsedNotebookError).toBeNull();

  const { error: collapsedDiscussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: collapsedNotebook!.id,
      user_id: userId,
      name: collapsedDiscussionName,
    });
  expect(collapsedDiscussionError).toBeNull();

  // Created second — the most recent discussion overall, so
  // findLatestDiscussion picks it and auto-expands this notebook instead.
  const { data: activeNotebook, error: activeNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: activeNotebookName })
    .select()
    .single();
  expect(activeNotebookError).toBeNull();

  const { error: activeDiscussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: activeNotebook!.id,
      user_id: userId,
      name: activeDiscussionName,
    });
  expect(activeDiscussionError).toBeNull();

  // Real session, real cookies — same pattern as the other E2E specs.
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

  await page.goto("/");

  const collapsedNotebookRow = page.getByRole("treeitem", {
    name: collapsedNotebookName,
  });
  const collapsedDiscussionRow = page.getByRole("treeitem", {
    name: collapsedDiscussionName,
  });

  await expect(collapsedNotebookRow).toBeVisible();
  // The other notebook's discussion, auto-expanded, confirms the page
  // genuinely loaded and settled (not a false negative from the
  // collapsed discussion simply never having had a chance to render).
  await expect(
    page.getByRole("treeitem", { name: activeDiscussionName }),
  ).toBeVisible();

  // Collapsed by default: its discussion is not in the tree at all.
  await expect(collapsedNotebookRow).toHaveAttribute("aria-expanded", "false");
  await expect(collapsedDiscussionRow).toHaveCount(0);

  // Click to expand — the discussion appears.
  await collapsedNotebookRow.click();
  await expect(collapsedNotebookRow).toHaveAttribute("aria-expanded", "true");
  await expect(collapsedDiscussionRow).toBeVisible();

  // Click again to collapse — the discussion disappears again.
  await collapsedNotebookRow.click();
  await expect(collapsedNotebookRow).toHaveAttribute("aria-expanded", "false");
  await expect(collapsedDiscussionRow).toHaveCount(0);
});
