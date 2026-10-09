import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 71 Stage 2. Choosing which earlier turns and pictures go with one
// question. The run itself is answered by a stand-in here (page.route), so
// these tests check what the PAGE asks for; the integration tests
// (execute-route) check that the server sends exactly that to the model.
// Runs in chromium and webkit-ipad.

function status(): {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
} {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
}

// A 1x1 PNG, so the pictures render as real images.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function seed(
  page: Page,
  context: BrowserContext,
  pictures: boolean,
): Promise<{ ids: string[]; notebookName: string; discussionName: string }> {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = status();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-history-choice-${suffix}@example.com`;
  const password = "correct horse battery staple 71!";
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no user");
  const userId = created.user.id;

  const notebookName = `E2E choice notebook ${suffix}`;
  const discussionName = `E2E choice discussion ${suffix}`;
  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
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

  const rows = [];
  for (let i = 0; i < 3; i++) {
    const content: unknown[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: `Question ${i + 1}` }],
      },
    ];
    if (pictures) {
      const path = `${userId}/${discussion!.id}/choice-${i}.png`;
      await admin.storage
        .from("prompt-images")
        .upload(path, PNG, { contentType: "image/png" });
      content.push({
        type: "image",
        attrs: { src: `/api/prompt-images/${path}` },
      });
    }
    rows.push({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: `Question ${i + 1}`,
      prompt_content: { type: "doc", content },
      response: `Answer ${i + 1}`,
      model: "m",
      resolved_model: "claude-sonnet-4-6",
      created_at: new Date(Date.UTC(2026, 8, 3, 10, i)).toISOString(),
    });
  }
  const { data: inserted } = await admin
    .from("responses")
    .insert(rows)
    .select("id, created_at")
    .order("created_at", { ascending: true });

  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (all) =>
        all.forEach(({ name, value }) => {
          const existing = jar.find((c) => c.name === name);
          if (existing) existing.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  await client.auth.signInWithPassword({ email, password });
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
  await expect(page.getByText("Answer 3")).toBeVisible({ timeout: 15_000 });
  return { ids: inserted!.map((r) => r.id), notebookName, discussionName };
}

// Answers the run with a stand-in and records what the page asked for.
async function captureRuns(page: Page) {
  const bodies: { context?: { turnIds?: string[]; picturesOff?: string[] } }[] =
    [];
  await page.route("**/api/execute", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ response: "done", resolved_model: "mock" }),
    });
  });
  return bodies;
}

async function run(page: Page, text: string) {
  await page.getByLabel("Prompt").fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    page.getByRole("button", { name: "Run", exact: true }).click(),
  ]);
}

const line = (page: Page) => page.locator("[data-context-summary]");

test.setTimeout(60_000);

test("with pictures, the line shows what goes with the question, and nothing is chosen until asked", async ({
  page,
  context,
}) => {
  await seed(page, context, true);
  await expect(line(page)).toHaveText(
    /^With this question: 3 earlier turns · 3 pictures · size: Small \(about [\d,]+\)$/,
  );
  const bodies = await captureRuns(page);
  await run(page, "What do the pictures show?");
  expect(bodies[0].context).toBeUndefined();
});

test("Choose…: leaving one turn's pictures out is what the run asks for, and it resets afterwards", async ({
  page,
  context,
}) => {
  const { ids } = await seed(page, context, true);
  await page.getByRole("button", { name: "Choose…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "What to send with this question",
  });
  await expect(dialog).toBeVisible();
  // Newest first.
  await expect(dialog.locator("[data-context-turn]").first()).toHaveAttribute(
    "data-context-turn",
    "3",
  );
  await dialog
    .locator('[data-context-turn="2"]')
    .getByLabel("send its picture")
    .click();
  await expect(dialog.locator("[data-context-dialog-summary]")).toContainText(
    "3 earlier turns · 2 of 3 pictures",
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(line(page)).toHaveText(
    /^Your choice\. With this question: 3 earlier turns · 2 of 3 pictures/,
  );

  const bodies = await captureRuns(page);
  await run(page, "Compare them.");
  expect(bodies[0].context).toEqual({ turnIds: ids, picturesOff: [ids[1]] });
  // One question only: back to everything.
  await expect(line(page)).toHaveText(
    /^With this question: 3 earlier turns · 3 pictures/,
  );
});

test("Ask about this answer only sends just that turn", async ({
  page,
  context,
}) => {
  const { ids } = await seed(page, context, true);
  const askButtons = page.getByRole("button", {
    name: "Ask about this answer only",
  });
  await expect(askButtons).toHaveCount(3);
  // The first answer's button.
  await askButtons.first().click();
  await expect(line(page)).toHaveText(
    /^Your choice\. With this question: 1 of 3 earlier turns · 1 of 3 pictures/,
  );
  const bodies = await captureRuns(page);
  await run(page, "Tell me more about this one.");
  expect(bodies[0].context).toEqual({ turnIds: [ids[0]] });
});

test("the quick buttons, and Send all turns", async ({ page, context }) => {
  await seed(page, context, true);
  await page.getByRole("button", { name: "Choose…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "What to send with this question",
  });
  const summary = dialog.locator("[data-context-dialog-summary]");
  await dialog.getByRole("button", { name: "No earlier turns" }).click();
  await expect(summary).toContainText("no earlier turns · 0 of 3 pictures");
  await dialog.getByRole("button", { name: "Only the last turn" }).click();
  await expect(summary).toContainText("1 of 3 earlier turns · 1 of 3 pictures");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Send all turns" }).click();
  await expect(line(page)).toHaveText(
    /^With this question: 3 earlier turns · 3 pictures/,
  );
});

test("a short discussion without pictures shows no line, and runs exactly as before", async ({
  page,
  context,
}) => {
  await seed(page, context, false);
  // Give the hint time to arrive if it were going to.
  await page.waitForResponse((r) => r.url().includes("/api/history-plan"));
  await expect(page.locator("[data-context-line]")).toHaveCount(0);
  const bodies = await captureRuns(page);
  await run(page, "And then?");
  expect(bodies[0].context).toBeUndefined();
  // Ask about this answer only is still there, next to Continue.
  await expect(
    page.getByRole("button", { name: "Ask about this answer only" }),
  ).toHaveCount(3);
});

test("the choice window is easy to tap: every row at least 44 points tall", async ({
  page,
  context,
}) => {
  await seed(page, context, true);
  await page.getByRole("button", { name: "Choose…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "What to send with this question",
  });
  const labels = dialog.locator("label");
  await expect(labels).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    const box = (await labels.nth(i).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  for (const name of ["Cancel", "Done", "All turns"]) {
    const box = (await dialog.getByRole("button", { name }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
