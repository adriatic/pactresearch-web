import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the header's client-visible switch-timing indicator: selecting a
// discussion in the tree eventually shows "Switched in <duration>" once its
// content and composer draft have finished loading, and a further switch
// updates it again (not a value frozen from the very first load).

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

const SWITCH_DURATION_PATTERN = /Switched in (\d+ms|\d+\.\d+s)/;

test.setTimeout(60_000);

test("selecting a discussion shows a switch-timing indicator that updates on the next switch", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-switch-timing-${suffix}@example.com`;
  const password = "correct horse battery staple 9!";
  const notebookName = `E2E switch-timing notebook ${suffix}`;
  const discussionAName = `E2E switch-timing discussion A ${suffix}`;
  const discussionBName = `E2E switch-timing discussion B ${suffix}`;

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

  const discussionALink = page.getByRole("treeitem", {
    name: discussionAName,
  });
  const discussionBLink = page.getByRole("treeitem", {
    name: discussionBName,
  });
  const switchIndicator = page.getByText(SWITCH_DURATION_PATTERN);

  await expect(discussionALink).toBeVisible();
  await expect(discussionBLink).toBeVisible();

  // Establish a known active discussion regardless of which one
  // findLatestDiscussion picked on initial load, then read the indicator's
  // text so the next switch can be proven to change it.
  await discussionALink.click();
  await expect(page.getByText(`Discussion: `)).toBeVisible();
  await expect(switchIndicator).toBeVisible();
  const firstIndicatorText = await switchIndicator.textContent();

  // A genuine switch re-measures and re-renders the indicator — not a
  // value frozen from the very first load.
  await discussionBLink.click();
  await expect(page.getByText(`Discussion: `)).toBeVisible();
  await expect(switchIndicator).toBeVisible();
  await expect
    .poll(() => switchIndicator.textContent())
    .not.toBe(firstIndicatorText);
});
