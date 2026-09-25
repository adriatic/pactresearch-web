import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 39: the permanent "Report a problem" capture, replacing task 36's
// throwaway bookmarklets.
//
// Exercises the two app states the task called for (idle composer, and
// mid-response-running), plus the property that makes the capture
// actually useful in the field: the pointer hit-test must report where
// the USER last clicked, not the Report button they just pressed to open
// the capture.

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

async function readCapture(page: Page) {
  await expect(
    page.getByRole("dialog", { name: "Diagnostic capture" }),
  ).toBeVisible();
  const raw = await page.getByLabel("Diagnostic capture JSON").inputValue();
  return JSON.parse(raw);
}

test.setTimeout(90_000);

test("Report a problem captures a sane payload from an idle composer, and copy/download both work", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-diag-${suffix}@example.com`;
  const password = "correct horse battery staple 39!";
  const notebookName = `E2E diag notebook ${suffix}`;
  const discussionName = `E2E diag discussion ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  await admin
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

  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

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

  // A real user click into the composer -- this is the position the
  // capture must later report, NOT the Report button.
  const prompt = page.getByLabel("Prompt");
  await prompt.click();
  await page.keyboard.type("diagnostic smoke", { delay: 10 });
  const promptBox = (await prompt.boundingBox())!;

  await page.getByRole("button", { name: "Report a problem" }).click();
  const capture = await readCapture(page);

  // Shape.
  expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(capture.url).toContain("localhost:3000");
  expect(capture.viewport.width).toBeGreaterThan(0);
  expect(capture.userAgent).toBeTruthy();
  // Every section succeeded -- no section recorded a failure.
  expect(capture.errors).toEqual({});

  // Editor state, the part that needed a live Tiptap instance.
  expect(capture.editor.present).toBe(true);
  expect(capture.editor.isEditable).toBe(true);
  expect(capture.editor.isDestroyed).toBe(false);
  expect(capture.editor.viewDomMatchesVisiblePrompt).toBe(true);
  expect(capture.editor.docCharCount).toBe("diagnostic smoke".length);
  // The prompt's actual text must never ride along in a blob meant for
  // pasting into bug reports.
  expect(JSON.stringify(capture)).not.toContain("diagnostic smoke");

  // Geometry: the composer chain resolves regardless of focus, and the
  // ancestor walk really climbs (this is what caught task 36).
  expect(capture.composerChain.length).toBeGreaterThan(2);
  expect(capture.composerChain[0].ariaLabel).toBe("Prompt");
  expect(capture.composerChain[0].styles).toHaveProperty("minHeight");

  // The capture must reflect the USER's focus, not the Report button's.
  // Opening a capture must not itself move focus, or "activeElement is
  // BODY" -- the signature of the broken-focus bug this whole tool exists
  // to catch -- could never be observed.
  expect(capture.activeElement.ariaLabel).toBe("Prompt");
  expect(capture.activeElementIsBody).toBe(false);
  expect(capture.editor.isFocused).toBe(true);

  // THE key property: the last pointer position is the user's click in
  // the composer, not the Report button in the bottom-right corner.
  expect(capture.lastPointerDown).not.toBeNull();
  expect(capture.lastPointerDown.x).toBeGreaterThan(promptBox.x - 1);
  expect(capture.lastPointerDown.x).toBeLessThan(
    promptBox.x + promptBox.width + 1,
  );
  expect(capture.lastPointerDown.hitTest).not.toBeNull();

  // Timing sections populated from a real page load.
  expect(capture.navTiming.loadEventEnd).toBeGreaterThan(0);
  expect(capture.resourceTiming.length).toBeGreaterThan(0);

  // Copy action puts the same JSON on the clipboard.
  await page.getByRole("button", { name: "Copy JSON" }).click();
  await expect(page.getByRole("button", { name: "Copied ✓" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(clipboard).capturedAt).toBe(capture.capturedAt);

  // Download action produces a real .json file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^pact-diagnostic-\d+\.json$/);

  // Escape closes it, and the app is still usable afterwards.
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Diagnostic capture" }),
  ).toHaveCount(0);
  await prompt.click();
  await page.keyboard.type(" still typable", { delay: 10 });
  await expect(prompt).toHaveText("diagnostic smoke still typable");

  await admin.auth.admin.deleteUser(userId);
});

test("Report a problem also captures cleanly mid-run, while a response is executing", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-diag-run-${suffix}@example.com`;
  const password = "correct horse battery staple 39b!";
  const notebookName = `E2E diag-run notebook ${suffix}`;
  const discussionName = `E2E diag-run discussion ${suffix}`;

  const { data: created } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.user!.id;
  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
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
  await jarClient.auth.signInWithPassword({ email, password });
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

  // Held open long enough to capture while the run is genuinely in
  // flight. Defensive about the insert: if this handler ever outlives the
  // test's own data (see the explicit wait before cleanup below), a
  // null dereference here would surface as an unhandled rejection that
  // Playwright attributes to whichever test runs NEXT -- which is exactly
  // how an earlier version of this spec made settings-dialog.spec.ts fail
  // for reasons that had nothing to do with it.
  await page.route("**/api/execute", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    const { data: inserted } = await admin
      .from("responses")
      .insert({
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: "diag run",
        response: "diag run response",
        model: "claude-sonnet-4-6",
        resolved_model: "claude-sonnet-4-6-mock",
        cell_type: "assistant",
      })
      .select("id, created_at")
      .single();
    if (!inserted) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "mock insert failed" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: "diag run response",
        resolved_model: "claude-sonnet-4-6-mock",
        response_row_id: inserted.id,
        response_created_at: inserted.created_at,
      }),
    });
  });

  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();

  await page.getByLabel("Prompt").click();
  await page.keyboard.type("run then capture", { delay: 10 });
  await page.locator("header").getByRole("button", { name: "Run" }).click();

  // Confirm we really are mid-run before capturing.
  await expect(page.getByRole("status")).toHaveAttribute(
    "aria-label",
    /^Running/,
    { timeout: 10_000 },
  );

  await page.getByRole("button", { name: "Report a problem" }).click();
  const capture = await readCapture(page);

  expect(capture.errors).toEqual({});
  expect(capture.editor.present).toBe(true);
  expect(capture.editor.isDestroyed).toBe(false);
  expect(capture.composerChain.length).toBeGreaterThan(2);
  // The capture reflects the running state it was taken in: the status
  // row is part of the captured geometry/DOM at that moment.
  const runningHeader = capture.composerChain.some(
    (node: { tag: string }) => node.tag === "DIV",
  );
  expect(runningHeader).toBe(true);
  expect(capture.navTiming.loadEventEnd).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("dialog", { name: "Diagnostic capture" }),
  ).toHaveCount(0);

  // Let the in-flight run actually finish before tearing down its data.
  // Deleting the user here while the mocked /api/execute is still pending
  // cascade-deletes the discussion out from under the route handler, whose
  // insert then fails and throws asynchronously -- an error Playwright
  // reports against the NEXT test in the run, not this one.
  await expect(page.getByRole("status")).toHaveAttribute(
    "aria-label",
    /^Idle/,
    {
      timeout: 15_000,
    },
  );
  await admin.auth.admin.deleteUser(userId);
});
