import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 44 item A: a completed response must render exactly once.
//
// Reported on production immediately after task 43's deploy: one prompt,
// the answer rendered twice -- a normal "Response — <timestamp>:" history
// entry, followed by a second block headed just "Response" with no
// timestamp, containing the identical text.
//
// Reproduced here deterministically rather than by racing real timing.
// /api/execute is mocked (no ANTHROPIC_API_KEY locally), and the mock
// reproduces production's exact event ORDER against the real Realtime
// channel the client subscribes to:
//
//   1. INSERT the responses row          -> Realtime INSERT (live preview opens)
//   2. fulfil the POST with the final text, row id and created_at
//   3. UPDATE the row a moment later     -> Realtime UPDATE lands LATE
//
// Step 3 is what production does on its final write, and the client's own
// POST-completion path now runs before that event arrives. The window is
// real: after folding the response into history and clearing the live
// preview, run() still awaits saveContent() before its finally block
// removes the channel, and a late UPDATE delivered during that await
// re-populates streamedResponse -- while leaving streamedResponseCreatedAt
// null, which is precisely why the duplicate block carries no timestamp.
//
// Run twice, once via the Run button and once via task 43's Cmd+Enter, to
// establish whether this is submit-path-specific or general.

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

test.setTimeout(90_000);

for (const submitVia of ["Run button", "Cmd+Enter"] as const) {
  test(`a completed response renders exactly once (submitted via ${submitVia})`, async ({
    page,
    context,
  }) => {
    const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
    const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `e2e-once-${suffix}@example.com`;
    const password = "correct horse battery staple 13!";
    const discussionName = `E2E once discussion ${suffix}`;
    const ANSWER = `UNIQUE-ANSWER-${suffix}`;

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

    const { data: notebook } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: `E2E once notebook ${suffix}` })
      .select()
      .single();
    const { data: discussion } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook!.id,
        user_id: userId,
        name: discussionName,
      })
      .select()
      .single();

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

    // Widen the genuine window rather than racing it. run()'s completion
    // path folds the response into history, clears the live preview, then
    // awaits saveContent() -- a PATCH -- before its finally block removes
    // the Realtime channel. In production that PATCH is a real network
    // round trip; locally it is ~10ms, far too short for the late UPDATE
    // to land inside it. Delaying the PATCH restores production's own
    // ordering. Same technique composer-switch-race.spec.ts uses for its
    // own window.
    await page.route("**/api/discussions?id=*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await new Promise((r) => setTimeout(r, 900));
      await route.fallback();
    });

    await page.route("**/api/execute", async (route) => {
      const { data: row } = await admin
        .from("responses")
        .insert({
          discussion_id: discussion!.id,
          user_id: userId,
          prompt_text: "once prompt",
          // Seeded with the FINAL text, not a partial. The row is real,
          // so any switch-load that resolves late refetches it -- and if
          // it held a placeholder at that moment, history would render
          // the placeholder and the assertion below would see zero
          // occurrences rather than the duplicate it is looking for.
          // (Observed exactly that under load: received 0, not 2.)
          // Counting occurrences still distinguishes the bug: one render
          // is correct, two is the duplicate.
          response: ANSWER,
          resolved_model: "claude-sonnet-4-6-mock",
        })
        .select()
        .single();

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          response: ANSWER,
          resolved_model: "claude-sonnet-4-6-mock",
          response_row_id: row!.id,
          response_created_at: row!.created_at,
        }),
      });

      // The late final write, exactly as production emits it — after the
      // POST has already returned. Not awaited: it must land while the
      // client is past its own completion path.
      setTimeout(() => {
        void admin
          .from("responses")
          .update({ response: ANSWER })
          .eq("id", row!.id);
      }, 150);
    });

    await page.goto("/");
    await page.getByRole("treeitem", { name: discussionName }).click();
    // Let the switch fully settle before running. Without this the
    // discussion's own history load can still be in flight when the run
    // completes, and its setHistory([]) -- correct at the time it was
    // issued, since the response row did not exist yet -- lands AFTER
    // the run folded its result in and wipes it. Observed directly:
    // <main> ended up completely empty, so the assertion saw zero
    // occurrences rather than the duplicate it looks for. The header's
    // data-switch-ms (task 44 item D) is exactly the "switch effect has
    // finished" signal for this.
    await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
    await expect(
      page.getByRole("group", { name: "Active discussion" }),
    ).toContainText(discussionName, { timeout: 15_000 });
    await page.waitForTimeout(1000);

    const prompt = page.getByLabel("Prompt");
    await prompt.fill("once prompt");

    if (submitVia === "Run button") {
      await page.locator("header").getByRole("button", { name: "Run" }).click();
    } else {
      await prompt.press("ControlOrMeta+Enter");
    }

    // Let the run finish AND the late Realtime UPDATE arrive.
    await expect(page.locator("main")).toContainText(ANSWER, {
      timeout: 20_000,
    });
    await page.waitForTimeout(2500);

    // Polled rather than read once: the duplicate this guards against is
    // persistent, so settling on exactly one render is the invariant --
    // and polling keeps a transient re-render from deciding the result.
    await expect
      .poll(
        () =>
          page
            .locator("main")
            .evaluate(
              (el, needle) => (el.textContent ?? "").split(needle).length - 1,
              ANSWER,
            ),
        { timeout: 10_000 },
      )
      .toBe(1);
  });
}
