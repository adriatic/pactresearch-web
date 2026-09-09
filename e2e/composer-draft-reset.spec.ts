import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies ExecuteTester's promptText reset through the real UI: an unsent
// draft typed while one discussion is active must not survive switching to
// a different discussion — and switching back must not restore it either,
// which would mean a hidden per-discussion cache rather than a genuine
// reset (the bug this test guards against).

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

test("switching discussions clears the composer's draft text, in both directions", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-draft-reset-${suffix}@example.com`;
  const password = "correct horse battery staple 8!";
  const notebookName = `E2E draft-reset notebook ${suffix}`;
  const discussionAName = `E2E draft-reset discussion A ${suffix}`;
  const discussionBName = `E2E draft-reset discussion B ${suffix}`;
  const draftText = `This draft should not survive switching discussions ${suffix}`;

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

  const { error: discussionAError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionAName,
  });
  expect(discussionAError).toBeNull();

  const { error: discussionBError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionBName,
  });
  expect(discussionBError).toBeNull();

  // Real session, real cookies — same pattern as
  // e2e/notebook-delete-lock.spec.ts: signed in server-side via a cookie
  // jar (no real magic-link email involved), then injected into the
  // actual browser context.
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

  const discussionALink = page.getByRole("link", { name: discussionAName });
  const discussionBLink = page.getByRole("link", { name: discussionBName });
  const composer = page.locator("textarea");

  await expect(discussionALink).toBeVisible();
  await expect(discussionBLink).toBeVisible();

  // Establish a known active discussion regardless of which one
  // findLatestDiscussion picked on initial load.
  await discussionALink.click();
  await expect(page.getByText(`Discussion: `)).toBeVisible();

  await composer.fill(draftText);
  await expect(composer).toHaveValue(draftText);

  await discussionBLink.click();
  await expect(composer).toHaveValue("");

  // Switch back — the draft must still be gone, not restored. A hidden
  // per-discussion cache would mask the underlying bug this test guards
  // against by making it look reset when it's really just parked.
  await discussionALink.click();
  await expect(composer).toHaveValue("");
});
