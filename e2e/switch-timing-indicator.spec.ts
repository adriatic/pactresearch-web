import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Verifies the header's switch-timing signal: selecting a discussion in the
// tree records a duration once that discussion's content and composer draft
// have finished loading, and a further switch updates it again (not a value
// frozen from the very first load).
//
// Task 44 item C removed the user-visible "Switched in <duration>" text --
// dev-era instrumentation with no value to a user. The measurement itself
// remains as the header's data-switch-ms attribute, so this spec is
// retargeted onto that rather than deleted: the invariant it guards (the
// switch effect completes, and re-measures on each subsequent switch) is
// still real and still worth pinning, and nine other specs depend on that
// same signal to know when a switch has settled.

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

test("selecting a discussion records a switch duration that updates on the next switch", async ({
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
  const header = page.locator("header[data-switch-ms]");
  const switchMs = () => header.getAttribute("data-switch-ms");

  await expect(discussionALink).toBeVisible();
  await expect(discussionBLink).toBeVisible();

  // Establish a known active discussion regardless of which one
  // findLatestDiscussion picked on initial load, then read the indicator's
  // text so the next switch can be proven to change it.
  await discussionALink.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionAName);
  await expect(header).toBeVisible();
  const firstSwitchMs = await switchMs();
  // A real measurement, not merely a present attribute.
  expect(Number(firstSwitchMs)).toBeGreaterThanOrEqual(0);

  // The removed text must be gone for users, not merely restyled.
  await expect(page.getByText(/Switched in/)).toHaveCount(0);

  // A genuine switch re-measures — not a value frozen from the first load.
  //
  // Proven by making the next switch measurably SLOWER rather than by
  // asserting the number merely differs. Against the production build
  // (task 48) a switch takes ~40ms, so two consecutive ones round to the
  // same integer often enough to make "not equal" a coin flip -- it
  // failed on exactly that, both switches reporting 43. Delaying this
  // switch's own fetches makes the re-measurement unambiguous, and
  // asserts something stronger: that the number tracks how long the
  // switch actually took.
  // Matched by predicate, not a glob: in a Playwright URL glob "?" is a
  // single-character wildcard, so "**/api/responses?discussionId=*" does
  // not match the real query string.
  await page.route(
    (url) => url.pathname === "/api/responses",
    async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fallback();
    },
  );

  await discussionBLink.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionBName);
  await expect(header).toBeVisible();
  await expect
    .poll(async () => Number(await switchMs()), { timeout: 15_000 })
    .toBeGreaterThan(Number(firstSwitchMs) + 400);
});
