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

test("expand/collapse state survives a page reload, and auto-expand for the active discussion still overrides a stored collapsed preference", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-expand-collapse-reload-${suffix}@example.com`;
  const password = "correct horse battery staple 12!";
  const otherNotebookName = `E2E reload other notebook ${suffix}`;
  const otherDiscussionName = `E2E reload other discussion ${suffix}`;
  const activeNotebookName = `E2E reload active notebook ${suffix}`;
  const activeDiscussionName = `E2E reload active discussion ${suffix}`;

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

  // Created first, so it's not the most recent discussion — collapsed by
  // default, same as the other test's setup.
  const { data: otherNotebook, error: otherNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: otherNotebookName })
    .select()
    .single();
  expect(otherNotebookError).toBeNull();

  const { error: otherDiscussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: otherNotebook!.id,
      user_id: userId,
      name: otherDiscussionName,
    });
  expect(otherDiscussionError).toBeNull();

  // Created second — the most recent discussion, so it's the one
  // findLatestDiscussion picks and its notebook auto-expands.
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

  const otherNotebookRow = page.getByRole("treeitem", {
    name: otherNotebookName,
  });
  const otherDiscussionRow = page.getByRole("treeitem", {
    name: otherDiscussionName,
  });
  const activeNotebookRow = page.getByRole("treeitem", {
    name: activeNotebookName,
  });
  const activeDiscussionRow = page.getByRole("treeitem", {
    name: activeDiscussionName,
  });

  await expect(otherNotebookRow).toBeVisible();
  await expect(activeDiscussionRow).toBeVisible();

  // Starting state: the active discussion's notebook is auto-expanded,
  // the other one is collapsed by default.
  await expect(otherNotebookRow).toHaveAttribute("aria-expanded", "false");
  await expect(activeNotebookRow).toHaveAttribute("aria-expanded", "true");

  // Manually expand the non-active notebook.
  await otherNotebookRow.click();
  await expect(otherNotebookRow).toHaveAttribute("aria-expanded", "true");
  await expect(otherDiscussionRow).toBeVisible();

  // Manually collapse the active notebook — explicitly against the
  // auto-expand rule, to prove a stored "collapsed" preference is what
  // gets persisted here, not just whatever the auto-expand effect wants.
  await activeNotebookRow.click();
  await expect(activeNotebookRow).toHaveAttribute("aria-expanded", "false");
  await expect(activeDiscussionRow).toHaveCount(0);

  await page.reload();

  const otherNotebookRowAfterReload = page.getByRole("treeitem", {
    name: otherNotebookName,
  });
  const activeNotebookRowAfterReload = page.getByRole("treeitem", {
    name: activeNotebookName,
  });

  await expect(otherNotebookRowAfterReload).toBeVisible();

  // Bug 1: the manually-expanded notebook is still expanded after a
  // same-tab reload — this is the actual bug, state wasn't being
  // persisted anywhere at all before this fix.
  await expect(otherNotebookRowAfterReload).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.getByRole("treeitem", { name: otherDiscussionName }),
  ).toBeVisible();

  // Bug 1's second half: auto-expand-for-the-active-discussion still
  // overrides a stored "collapsed" preference — the notebook containing
  // the (still) active discussion is expanded again despite being
  // explicitly collapsed right before the reload.
  await expect(activeNotebookRowAfterReload).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.getByRole("treeitem", { name: activeDiscussionName }),
  ).toBeVisible();
});
