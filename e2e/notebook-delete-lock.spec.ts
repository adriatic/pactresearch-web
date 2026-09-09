import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the notebook-delete lock check (0fbc8c6) through the real UI:
// a real browser, a real Next.js dev server, a real DELETE /api/notebooks
// request, and the real 409 the route returns when a discussion has an
// active execution lock — not the route called directly, as the
// integration tests already cover.

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

test("deleting a notebook with an actively executing discussion is blocked, with the real 409 and the real UI error message", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  // Fresh, uniquely-named fixture data — no reliance on, or interference
  // with, whatever else exists in the local DB from other testing.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-lock-delete-${suffix}@example.com`;
  const password = "correct horse battery staple 7!";
  const notebookName = `E2E lock-blocked notebook ${suffix}`;
  const discussionName = `E2E actively executing discussion ${suffix}`;

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

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  // A fresh, genuinely active lock — well within the shared 5-minute
  // staleness threshold, exactly the scenario this check exists for.
  const { error: lockError } = await admin.from("execution_locks").insert({
    user_id: userId,
    discussion_id: discussion!.id,
    acquired_at: new Date().toISOString(),
  });
  expect(lockError).toBeNull();

  // Real session, real cookies — signed in server-side (no real magic-link
  // email involved), then injected into the actual browser context so the
  // app's own proxy.ts/server client read a genuine authenticated session,
  // the same as a real logged-in user.
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
  await expect(page.getByRole("heading", { name: notebookName })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());

  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/notebooks") &&
      response.request().method() === "DELETE",
  );

  await page
    .locator("h3", { hasText: notebookName })
    .getByRole("button", { name: "Delete notebook" })
    .click();

  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(409);

  await expect(
    page.getByText(
      `"${notebookName}" can't be deleted right now — a discussion in it is actively executing.`,
    ),
  ).toBeVisible();

  // The notebook's heading is still on the page — the delete genuinely
  // didn't go through, not just "the error text happened to appear."
  // Scoped to the heading role specifically: the error message above also
  // contains notebookName (quoted), so a plain text match would now hit
  // both and violate Playwright's strict mode.
  await expect(page.getByRole("heading", { name: notebookName })).toBeVisible();

  // Proven against the database itself, not inferred from the UI alone.
  const { data: notebookRows, error: notebookCheckError } = await admin
    .from("notebooks")
    .select("*")
    .eq("id", notebook!.id);
  expect(notebookCheckError).toBeNull();
  expect(notebookRows).toHaveLength(1);
});
