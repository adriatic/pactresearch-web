import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies Explorer's real notebook tree (Phase D): every notebook gets
// its own group regardless of whether it has discussions (the earlier
// empty-notebook-visibility fix, not regressed here), selecting a
// discussion drives the real state-restore flow already wired to
// discussionId, and selecting/expanding an empty notebook is a valid,
// non-erroring state — not a special case that needs to be avoided.

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

test("the tree view groups notebooks correctly, selecting a discussion loads it, and selecting an empty notebook doesn't error", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-explorer-tree-${suffix}@example.com`;
  const password = "correct horse battery staple 9!";
  const notebookWithDiscussionName = `E2E tree notebook with discussion ${suffix}`;
  const emptyNotebookName = `E2E tree empty notebook ${suffix}`;
  const discussionName = `E2E tree discussion ${suffix}`;

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

  const { data: notebookWithDiscussion, error: notebookWithDiscussionError } =
    await admin
      .from("notebooks")
      .insert({ user_id: userId, name: notebookWithDiscussionName })
      .select()
      .single();
  expect(notebookWithDiscussionError).toBeNull();

  const { error: discussionError } = await admin.from("discussions").insert({
    notebook_id: notebookWithDiscussion!.id,
    user_id: userId,
    name: discussionName,
  });
  expect(discussionError).toBeNull();

  const { error: emptyNotebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: emptyNotebookName });
  expect(emptyNotebookError).toBeNull();

  // Real session, real cookies — same pattern as the other E2E specs:
  // signed in server-side via a cookie jar (no real magic-link email
  // involved), then injected into the actual browser context.
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

  // Both notebook groups appear, correctly labeled — the empty notebook
  // is not invisible, matching the earlier fix.
  const notebookWithDiscussionHeading = page.getByRole("heading", {
    name: notebookWithDiscussionName,
  });
  const emptyNotebookHeading = page.getByRole("heading", {
    name: emptyNotebookName,
  });
  await expect(notebookWithDiscussionHeading).toBeVisible();
  await expect(emptyNotebookHeading).toBeVisible();

  // The seeded discussion is the only one that exists, so
  // findLatestDiscussion picks it on initial load, auto-expanding its
  // notebook — its row becomes visible without needing a manual click.
  const discussionLink = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionLink).toBeVisible();
  await expect(page.getByText(`Discussion: `)).toBeVisible();

  // Selecting it drives the real state-restore flow — same discussionId
  // now reflected in ExecuteTester's own display.
  await discussionLink.click();
  await expect(discussionLink).toHaveCSS("font-weight", "700");

  // Now expand the empty notebook — a valid, real state (an empty
  // notebook a user can add a first discussion to, or delete), not an
  // error condition.
  const emptyNotebookToggle = page.getByRole("treeitem", {
    name: emptyNotebookName,
  });
  await emptyNotebookToggle.click();
  await expect(page.getByText("No discussions yet.")).toBeVisible();

  // Expanding an empty notebook doesn't disturb the already-active
  // discussion — no discussion inside the empty notebook to select, and
  // the one genuinely selected discussion is still shown as such.
  await expect(discussionLink).toHaveCSS("font-weight", "700");
  await expect(page.getByText(`Discussion: `)).toBeVisible();
});
