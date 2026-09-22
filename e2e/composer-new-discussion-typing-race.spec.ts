import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 36: reported in production as "the composer has zero height on a
// new discussion and cannot be typed into at all" -- a correction to
// task 35, whose border-visibility fix was real but incomplete. Despite
// extensive reproduction attempts directly against production (multiple
// viewport sizes, a throttled network, WebKit, a brand-new notebook vs a
// new discussion added to an already-active one, an immediate page
// reload), a literal zero-height composer panel was never reproduced --
// the panel and its underlying editor were always correctly sized and
// mounted.
//
// What *was* found, reliably, directly against production: typing
// immediately after creating a discussion could be silently wiped back
// to empty a moment later. Root cause: useDiscussionExecution.ts's
// discussion-switch effect claims the new discussionId as "active"
// synchronously (activeDiscussionIdRef.current = discussionId, before
// either of its own awaits), but its own async load of that discussion's
// real content (history + draft) can still be in flight when the user
// starts typing. Once that load resolves, it applied the server's
// resolved content unconditionally -- for any brand-new discussion,
// that's always EMPTY_DOC, so the very first thing typed could vanish
// the instant the load happened to finish, regardless of the panel's own
// (correctly nonzero) height the whole time. A user watching their own
// typed text disappear back to nothing could very plausibly describe
// that experience as "I can't type into it."
//
// Reproduced locally with artificial latency on the exact two requests
// the switch-load effect makes (same technique composer-switch-race.spec.ts
// already uses for its own, different incoming-vs-outgoing race) --
// local dev's near-zero round trips otherwise close the window too fast
// to reliably land a few sequential actions inside it, same reasoning as
// that spec's own comment.
//
// Distinct from composer-switch-race.spec.ts, which guards the OUTGOING
// side (the departing discussion's own draft-save being corrupted by
// leftover content from before its load ever resolved). This guards the
// INCOMING side: the arriving discussion's own load overwriting content
// the user has already, genuinely typed into it since the switch began.

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

test("typing immediately after creating a brand-new discussion survives the discussion's own (slower) load resolving afterward", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-new-disc-typing-race-${suffix}@example.com`;
  const password = "correct horse battery staple 36!";
  const notebookName = `E2E new-disc-typing-race notebook ${suffix}`;
  const discussionName = `E2E new-disc-typing-race discussion ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }

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

  // Artificial latency on the exact two requests the switch-load effect
  // makes -- widens the real race window to something reliably
  // observable rather than depending on local dev's own near-zero
  // latency to happen to expose it (same technique and reasoning as
  // composer-switch-race.spec.ts's own comment).
  await page.route("**/api/discussions?id=*", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.route("**/api/responses?discussionId=*", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  await page.goto("/");
  await page.getByText(/Switched in/).waitFor({ timeout: 15_000 });

  await page.getByLabel("Name:").first().fill(notebookName);
  await page.getByRole("button", { name: "Create notebook" }).click();

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("Name:").nth(1).fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();

  // No wait at all -- type immediately, exactly while the (artificially
  // slowed) discussion/responses fetches for this brand-new discussion
  // are still in flight. This is the real race window: the composer is
  // already mounted and enabled (never disabled while loading), so
  // nothing stops a real user from typing right away.
  const prompt = page.getByLabel("Prompt");
  await prompt.click();
  const typedText = "typed before the switch load resolves";
  await page.keyboard.type(typedText, { delay: 10 });

  // Wait out the artificial delay plus a margin -- long enough for the
  // switch's own load to have definitely resolved by now.
  await page.waitForTimeout(1500);

  // The actual bug: this used to come back empty (the load's own
  // resolution silently overwrote it with EMPTY_DOC, this discussion's
  // real, empty server-side state) the moment it resolved after typing
  // had already started.
  await expect(prompt).toHaveText(typedText);
});
