import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the active discussion's name renders as its actual name
// (already loaded, same as the Explorer sidebar) rather than its raw
// UUID — it used to show discussionId directly.
//
// Task 38 moved WHERE that name lives, not whether it's covered. It was
// DiscussionContent's "Discussion: <name>" line; task 37 added
// ComposerHeader directly above the composer showing the same name, so
// the two duplicated each other and the DiscussionContent one was
// removed. This assertion follows the name to ComposerHeader rather than
// being deleted, so the original regression (a uuid rendering as
// identifying text) stays guarded.

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

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.setTimeout(60_000);

test("the discussion header shows the discussion's name, not its raw id", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-header-name-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const notebookName = `E2E header-name notebook ${suffix}`;
  const discussionName = `E2E header-name discussion ${suffix}`;

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

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { error: discussionError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });
  expect(discussionError).toBeNull();

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

  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionRow).toBeVisible();
  await discussionRow.click();

  // Scoped to ComposerHeader by its accessible name -- the discussion
  // name also appears in the Explorer tree, so an unscoped text lookup
  // would match more than one element.
  const header = page.getByRole("group", { name: "Active discussion" });
  await expect(header).toBeVisible();
  await expect(header).toContainText(discussionName);
  await expect(header).not.toHaveText(UUID_PATTERN);

  // The superseded "Discussion: <name>" line must be gone, not merely
  // moved -- showing the name in both places at once is the redundancy
  // task 38 removed.
  await expect(page.getByText("Discussion: ")).toHaveCount(0);
});
