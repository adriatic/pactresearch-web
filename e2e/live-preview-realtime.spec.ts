import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 45. The live-preview path, exercised through REAL Realtime events
// rather than inferred from other state.
//
// This was untestable until now, and the reason was a product bug, not a
// harness limitation. The phx_join frame went out carrying only
// `?apikey=<anon>` and no access_token, so Realtime authorized the
// subscription as anon, RLS on `responses` matched nothing, and no event
// was ever delivered -- while the channel still reported SUBSCRIBED.
// run() now calls supabase.realtime.setAuth() before subscribing.
//
// The second test is the regression guard task 44's fix never had: it
// reproduces the exact race that shipped a duplicate response to
// production, which requires a real late UPDATE and so could not be
// written before this.

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

async function signedInWorkspace(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-live-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const discussionName = `E2E live discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) {
    throw userErr ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: `E2E live notebook ${suffix}` })
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

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const existing = jar.find((c) => c.name === name);
          if (existing) existing.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;
  await context.addCookies(
    jar.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );

  return { admin, userId, discussion: discussion!, discussionName, suffix };
}

test.setTimeout(90_000);

test("streaming content renders from a real Realtime event, before the run returns", async ({
  page,
  context,
}) => {
  const { admin, userId, discussion, discussionName, suffix } =
    await signedInWorkspace(page, context);
  const PARTIAL = `PARTIAL-${suffix}`;

  let releasePost: () => void = () => {};
  const postHeld = new Promise<void>((r) => {
    releasePost = r;
  });

  await page.route("**/api/execute", async (route) => {
    // The row lands first, exactly as /api/execute's own message_start
    // insert does -- this is the event the live preview exists to show.
    await admin.from("responses").insert({
      discussion_id: discussion.id,
      user_id: userId,
      prompt_text: "live prompt",
      response: PARTIAL,
      model: "m",
      resolved_model: "claude-sonnet-4-6-mock",
    });
    // Hold the POST open so anything visible now can ONLY have come from
    // Realtime -- not from the response body.
    await postHeld;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: `${PARTIAL} and then the rest`,
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await page.getByLabel("Prompt").fill("live prompt");
  await page.locator("header").getByRole("button", { name: "Run" }).click();

  // Delivered over the socket while the request is still in flight.
  await expect(page.locator("main")).toContainText(PARTIAL, {
    timeout: 20_000,
  });
  await expect(page.locator("main")).toContainText("Live response");

  releasePost();
  await expect(page.locator("main")).toContainText("and then the rest", {
    timeout: 20_000,
  });
});

test("a late Realtime UPDATE after the run is folded into history does not reopen the live preview", async ({
  page,
  context,
}) => {
  const { admin, userId, discussion, discussionName, suffix } =
    await signedInWorkspace(page, context);
  const ANSWER = `ANSWER-${suffix}`;

  // Widen the window the way production has it: run() folds, clears, then
  // awaits a draft save before its finally block removes the channel.
  await page.route("**/api/discussions?id=*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await new Promise((r) => setTimeout(r, 1200));
    await route.fallback();
  });

  await page.route("**/api/execute", async (route) => {
    const { data: row } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion.id,
        user_id: userId,
        prompt_text: "fold prompt",
        response: ANSWER,
        model: "m",
        resolved_model: "claude-sonnet-4-6-mock",
      })
      .select()
      .single();

    // response_row_id + response_created_at are what make the client fold
    // this into history and clear the live preview.
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

    // The late final write, after the POST has already returned -- the
    // event that used to reopen the preview and render the response a
    // second time, with no timestamp.
    setTimeout(() => {
      void admin
        .from("responses")
        .update({ response: ANSWER })
        .eq("id", row!.id);
    }, 250);
  });

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
  await page.waitForTimeout(1000);

  await page.getByLabel("Prompt").fill("fold prompt");
  await page.locator("header").getByRole("button", { name: "Run" }).click();

  await expect(page.locator("main")).toContainText(ANSWER, {
    timeout: 20_000,
  });
  // Well past the late UPDATE and the delayed PATCH.
  await page.waitForTimeout(3000);

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

  // The duplicate's own signature: a second, timestamp-less "Response"
  // heading. History entries always carry a date, so a bare one can only
  // be a reopened live preview.
  const liveHeadings = await page
    .locator("main h2")
    .filter({ hasText: /^Response$/ })
    .count();
  expect(liveHeadings).toBe(0);
});
