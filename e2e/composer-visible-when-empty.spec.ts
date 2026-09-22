import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Regression coverage for task 34: a discussion with an empty composer
// (its normal starting state -- a brand-new discussion, or any discussion
// right after a successful run clears it) was reported as "the composer
// is missing" in production. It never was missing -- it was fully
// present and functional the whole time (confirmed by reproducing
// against production directly: click, type, Run all worked normally) --
// it was simply invisible: no border, no background, nothing
// distinguishing an empty editor from blank page whitespace, so an empty
// composer was indistinguishable from no composer at all.
//
// This gap existed from the very first version of the Tiptap composer
// (task 29) — task 28's own approved design proposal specified a
// `border: 1px solid #888` wrapper explicitly, but the implementation
// never actually added it. Every existing composer e2e spec interacts
// with the editor via getByLabel("Prompt") (an ARIA-based locator, blind
// to visual styling) or asserts its pixel *size* (composer-divider.spec.ts),
// never whether it has any visible affordance when empty -- so nothing
// in the existing suite could have caught this. This spec closes that
// gap: it asserts the composer has a real, visible border independent of
// whether it holds any content.

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

test("the composer has a visible border even when completely empty, not just when it holds text", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-composer-visible-${suffix}@example.com`;
  const password = "correct horse battery staple 34!";
  const notebookName = `E2E composer-visible notebook ${suffix}`;
  const discussionName = `E2E composer-visible discussion ${suffix}`;

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

  const { error: discussionError } = await admin
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
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();

  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveText("");

  // Walk up from the actual contenteditable to find the composer's own
  // bordered wrapper (Composer.tsx's outer div, two levels up from the
  // .ProseMirror element EditorContent renders) and confirm it genuinely
  // has a visible border while the editor is still completely empty --
  // not after typing something into it, which is what every other
  // composer spec already incidentally does first.
  const borderStyle = await prompt.evaluate((el) => {
    let node: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      const style = getComputedStyle(node);
      if (style.borderStyle !== "none" && style.borderWidth !== "0px") {
        return {
          borderStyle: style.borderStyle,
          borderWidth: style.borderWidth,
        };
      }
      node = node.parentElement;
    }
    return null;
  });

  expect(borderStyle).not.toBeNull();
  expect(borderStyle?.borderStyle).toBe("solid");
  expect(borderStyle?.borderWidth).not.toBe("0px");
});
