import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { docToPlainText } from "@/lib/richContent";

// Confirms the rich composer's autosave-while-typing actually fires on a
// real ~2000ms debounce -- real wall-clock timing, not a mocked timer --
// and does NOT fire before that, so a normal pause mid-typing doesn't
// spam PATCH /api/discussions.

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

test.setTimeout(30_000);

test("autosave persists a typed draft on its own, on a ~2s debounce, with no switch or run involved", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-autosave-timing-${suffix}@example.com`;
  const password = "correct horse battery staple 51!";
  const notebookName = `E2E autosave notebook ${suffix}`;
  const discussionName = `E2E autosave discussion ${suffix}`;
  const draftText = `autosaved without switching or running ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
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

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) existing.value = value;
          else capturedCookies.push({ name, value });
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
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });
  await discussionRow.click();

  const typedAt = Date.now();
  await page.getByLabel("Prompt").fill(draftText);

  async function readDraft() {
    const { data, error } = await admin
      .from("discussions")
      .select("draft_content")
      .eq("id", discussion!.id)
      .single();
    expect(error).toBeNull();
    return data!.draft_content;
  }

  // Not yet -- well inside the debounce window (checked at ~800ms, a
  // real, generous margin under the 2000ms debounce so this isn't a
  // photo finish against normal test/network jitter).
  await page.waitForTimeout(800);
  const beforeDebounce = await readDraft();
  expect(beforeDebounce).toBeNull();

  // Now it should have landed -- the debounce is real wall-clock time,
  // not simulated, so this genuinely waits past the ~2000ms mark from
  // when typing happened above (already ~800ms elapsed; wait the rest
  // plus real margin for the PATCH round trip itself).
  const elapsedSoFar = Date.now() - typedAt;
  await page.waitForTimeout(Math.max(0, 2_500 - elapsedSoFar));

  await expect(async () => {
    const afterDebounce = await readDraft();
    expect(afterDebounce).not.toBeNull();
    expect(docToPlainText(afterDebounce)).toBe(draftText);
  }).toPass({ timeout: 3_000 });
});
