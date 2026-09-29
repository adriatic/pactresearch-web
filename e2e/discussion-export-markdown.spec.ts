import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 65. The real UI path: open a discussion row's menu, pick Export,
// and inspect the file the browser actually downloaded -- not the
// endpoint's JSON. The integration tests already cover what the route
// renders; what only this can show is that the menu item exists, the
// download fires, and the bytes on disk are the markdown, with a .md
// name, rather than a .pact bundle or a JSON envelope.

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

test("exporting a discussion downloads a readable markdown file of that discussion alone", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-discussion-export-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const notebookName = `E2E discussion-export notebook ${suffix}`;
  const discussionName = `E2E exported discussion ${suffix}`;
  const siblingName = `E2E sibling discussion ${suffix}`;

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

  const { data: sibling, error: siblingError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: siblingName,
    })
    .select()
    .single();
  expect(siblingError).toBeNull();

  const codeResponse = [
    "Two ways:",
    "",
    "- square it",
    "- or don't",
    "",
    "```python",
    "def f(x):",
    "    return x ** 2",
    "```",
  ].join("\n");

  // Three turns on the exported discussion, one of them still in flight,
  // plus one on the sibling that must not appear. Explicit created_at
  // values, inserted out of order, so the file's ordering is real.
  const { error: cellsError } = await admin.from("responses").insert([
    {
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: "second prompt: show me code",
      response: codeResponse,
      resolved_model: "claude-sonnet-4-6",
      created_at: "2026-09-07T00:02:00Z",
    },
    {
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: "first prompt: what is the Lagrangian",
      response: "It is \\(T - V\\), the kinetic minus the potential.",
      resolved_model: "claude-sonnet-4-6",
      created_at: "2026-09-07T00:01:00Z",
    },
    {
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: "third prompt: still running",
      response: null,
      created_at: "2026-09-07T00:03:00Z",
    },
    {
      discussion_id: sibling!.id,
      user_id: userId,
      prompt_text: "sibling prompt",
      response: "SIBLING CONTENT MUST NOT APPEAR",
      resolved_model: "claude-sonnet-4-6",
      created_at: "2026-09-07T00:01:30Z",
    },
  ]);
  expect(cellsError).toBeNull();

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

  const discussionRow = page.getByRole("treeitem", {
    name: discussionName,
    exact: true,
  });
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(discussionRow, discussionName, "Export"),
  ]);

  // Markdown, not .pact, and named after the discussion plus the date.
  expect(download.suggestedFilename()).toMatch(
    /^E2E-exported-discussion-.*-\d{4}-\d{2}-\d{2}\.md$/,
  );
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  const markdown = readFileSync(downloadedPath!, "utf-8");

  // Opens cleanly as plain markdown: a document, not a JSON envelope.
  expect(markdown.startsWith(`# ${discussionName}\n`)).toBe(true);
  expect(markdown.trimStart().startsWith("{")).toBe(false);
  expect(markdown).toContain(`From notebook **${notebookName}**`);

  // Every turn, in order.
  expect(markdown.match(/^## Turn \d+$/gm)).toEqual([
    "## Turn 1",
    "## Turn 2",
    "## Turn 3",
  ]);
  expect(markdown.indexOf("first prompt")).toBeLessThan(
    markdown.indexOf("second prompt"),
  );
  expect(markdown.indexOf("second prompt")).toBeLessThan(
    markdown.indexOf("third prompt"),
  );

  // Only this discussion.
  expect(markdown).not.toContain("SIBLING CONTENT MUST NOT APPEAR");
  expect(markdown).not.toContain("sibling prompt");

  // The code block and list arrive intact, not escaped or re-wrapped.
  expect(markdown).toContain(codeResponse);

  // Math is in the dollar form a markdown viewer can typeset.
  expect(markdown).toContain("It is $T - V$, the kinetic minus the potential.");
  expect(markdown).not.toContain("\\(");

  // The in-flight turn is marked rather than shown as an empty answer.
  expect(markdown).toContain(
    "_No response recorded — this turn did not complete._",
  );

  // Nothing internal.
  expect(markdown).not.toContain(discussion!.id);
  expect(markdown).not.toContain("claude-sonnet-4-6");

  // ---------------------------------------------------------------
  // The second entry point: the Export button on the active-discussion
  // header. The risk worth testing is not that it works, it is that it
  // DRIFTS from the row menu -- a different endpoint, a different
  // filename, a different file. So the assertion is that the two
  // downloads are identical, byte for byte.
  //
  // The page opened on the sibling (findLatestDiscussion picks the most
  // recently created), so selecting the row first is also what makes
  // this a real test of "export what I am looking at".
  const header = page.getByRole("group", { name: "Active discussion" });
  await expect(header).toContainText(siblingName);

  await discussionRow.click();
  await expect(header).toContainText(discussionName, { timeout: 15_000 });

  // Measured, and the reason the button is named "Export discussion"
  // rather than "Export": Playwright matches accessible names by
  // case-insensitive substring, and this notebook is named "E2E
  // discussion-export notebook ...", so a page-level loose "Export"
  // also finds its row-menu trigger. The longer name is unambiguous on
  // its own; if someone shortens it, this fails and says why.
  expect(
    await page.getByRole("button", { name: "Export" }).count(),
  ).toBeGreaterThan(1);
  expect(
    await page
      .getByRole("button", { name: "Export discussion", exact: true })
      .count(),
  ).toBe(1);

  const [headerDownload] = await Promise.all([
    page.waitForEvent("download"),
    header
      .getByRole("button", { name: "Export discussion", exact: true })
      .click(),
  ]);

  expect(headerDownload.suggestedFilename()).toBe(download.suggestedFilename());
  const headerPath = await headerDownload.path();
  expect(readFileSync(headerPath!, "utf-8")).toBe(markdown);
});
