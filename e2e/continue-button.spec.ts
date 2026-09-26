import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 49. Continue clears the composer and points its placeholder at the
// question that response ended on, so a reply can be typed without first
// deleting the prompt task 44 item B2 deliberately retains.
//
// The per-cell assertions are the point: each response's button must
// surface ITS OWN trailing question, not the newest one in the
// discussion. The last test pins that task 44's retained prompt is
// untouched until Continue is actually pressed.

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

const QUESTION_ONE = "What's happening with her care needs?";
const QUESTION_TWO = "Which option would you like to explore first?";

test.setTimeout(90_000);

async function seed(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-continue-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const discussionName = `E2E continue discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw userErr ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: `E2E continue notebook ${suffix}` })
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

  // Oldest first: two responses ending in different questions, then one
  // ending in no question at all.
  for (const [prompt, response] of [
    ["first prompt", `You're doing the right thing by her. ${QUESTION_ONE}`],
    ["second prompt", `Here are a few routes.\n\n${QUESTION_TWO}`],
    ["third prompt", "That covers it. Nothing further is needed here."],
  ]) {
    await admin.from("responses").insert({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: prompt,
      response,
      model: "m",
      resolved_model: "claude-sonnet-4-6-mock",
    });
    // Distinct created_at ordering.
    await new Promise((r) => setTimeout(r, 15));
  }

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
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

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
  return { discussionName };
}

// The Placeholder extension renders its text via data-placeholder on the
// empty paragraph (see PLACEHOLDER_STYLE in Composer.tsx).
function placeholderOf(page: import("@playwright/test").Page) {
  return page.locator(".tiptap p.is-editor-empty").first();
}

test("Continue clears and focuses the composer, and surfaces that response's own question", async ({
  page,
  context,
}) => {
  await seed(page, context);
  const prompt = page.getByLabel("Prompt");

  const continueButtons = page.getByRole("button", { name: "Continue" });
  await expect(continueButtons).toHaveCount(3);

  // The composer opens holding the last cell's prompt -- task 44's
  // retained-prompt behaviour. Waited on explicitly rather than assumed:
  // the load resolves asynchronously and would otherwise repopulate the
  // composer straight after the clear below.
  //
  // This is also the friction Continue exists to remove: replying to the
  // response's question means deleting this first.
  await expect(prompt).toHaveText("third prompt", { timeout: 15_000 });

  // Deliberately NOT emptying the composer by hand here to check the
  // default hint first. Doing that raced a late-resolving discussion
  // load under full-suite load, which repopulated the composer with the
  // retained prompt a moment after the clear -- a flake in the test, not
  // the feature. The default hint is asserted further down anyway, on
  // the response that ends in no question, by which point the load has
  // long settled.
  //
  // The retained prompt above doubles as the "cleared" precondition: it
  // is real content sitting in the composer that Continue has to remove.

  // The FIRST (oldest) response's Continue -- deliberately not the newest,
  // to prove the button is per-cell.
  await continueButtons.nth(0).click();
  await expect(prompt).toHaveText("");
  // ...and stays cleared: nothing repopulates it behind the click.
  await page.waitForTimeout(500);
  await expect(prompt).toHaveText("");
  await expect(prompt).toBeFocused();
  await expect(placeholderOf(page)).toHaveAttribute(
    "data-placeholder",
    `Reply to: "${QUESTION_ONE}"`,
  );

  // The SECOND response surfaces its own question, not the first's.
  await continueButtons.nth(1).click();
  await expect(prompt).toHaveText("");
  await expect(placeholderOf(page)).toHaveAttribute(
    "data-placeholder",
    `Reply to: "${QUESTION_TWO}"`,
  );

  // The THIRD ends in no question: fall back to the standard hint rather
  // than showing something misleading.
  await continueButtons.nth(2).click();
  await expect(prompt).toHaveText("");
  await expect(placeholderOf(page)).toHaveAttribute(
    "data-placeholder",
    /Enter prompt/,
  );

  // Focused and genuinely typeable afterwards -- including when the
  // fallback hint is used, since Continue still clears and focuses.
  await expect(prompt).toBeFocused();
  await page.keyboard.type("my reply");
  await expect(prompt).toHaveText("my reply");
});

test("task 44's retained prompt is untouched until Continue is pressed", async ({
  page,
  context,
}) => {
  await seed(page, context);
  const prompt = page.getByLabel("Prompt");

  await page.route("**/api/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: `All done. ${QUESTION_ONE}`,
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    });
  });

  const typed = "a prompt worth keeping";
  await prompt.fill(typed);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    page.locator("header").getByRole("button", { name: "Run" }).click(),
  ]);

  // Task 44 item B2: the run completing leaves the prompt in place.
  await expect(page.locator("main")).toContainText("All done.", {
    timeout: 15_000,
  });
  await expect(prompt).toHaveText(typed);
  await page.waitForTimeout(1000);
  await expect(prompt).toHaveText(typed);

  // Only pressing Continue clears it.
  await page.getByRole("button", { name: "Continue" }).last().click();
  await expect(prompt).toHaveText("");
});
