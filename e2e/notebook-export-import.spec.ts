import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Verifies the real UI round trip: export a notebook to a real downloaded
// .pact file, feed that exact file back into the Import flow, and confirm
// a second, independent, content-identical notebook appears in the tree
// -- the actual point of this feature (repeatable test fixtures).

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

test("exporting a notebook and importing it back creates a second, content-identical notebook in the tree", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-export-import-${suffix}@example.com`;
  const password = "correct horse battery staple 12!";
  const notebookName = `E2E export-import notebook ${suffix}`;
  const discussionName = `E2E export-import discussion ${suffix}`;

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
    .insert({
      user_id: userId,
      name: notebookName,
      system_prompt: "Be concise.",
      category: "Dev Test",
    })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
      total_time_ms: 1234,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  const { error: cellError } = await admin.from("responses").insert({
    discussion_id: discussion!.id,
    user_id: userId,
    prompt_text: "What is the export/import round trip for?",
    response: "Repeatable test fixtures.",
    model: "claude-sonnet-4-6",
    resolved_model: "claude-sonnet-4-6-20260101",
    cell_type: "assistant",
  });
  expect(cellError).toBeNull();

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

  // Exactly one notebook row exists before the import.
  const notebookRows = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRows).toHaveCount(1);

  // Real download, via the real Export button -- not a fabricated file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(notebookRows, notebookName, "Export"),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pact$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  // The hidden file input behind the header's "Import" button -- setting
  // files directly on it is the standard Playwright pattern for file
  // inputs (works even when the input itself is display:none).
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles(downloadedPath!);

  // The import created a second, independent notebook -- the tree now
  // shows two rows where it showed one. Its name is the original plus a
  // " 1" suffix, since importing back into the same account collides
  // with the notebook it was exported from (getByRole's name option is a
  // substring match, so both rows still match notebookName). A longer
  // timeout than this suite's usual default: unlike a typical
  // single-fetch UI action, this round trip is a file read followed by
  // three sequential inserts (notebook, discussions, cells) and then the
  // Explorer's own refetch -- genuinely more work, so it's more sensitive
  // to system load than most assertions in this suite.
  await expect(notebookRows).toHaveCount(2, { timeout: 15_000 });
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 1` }),
  ).toHaveCount(1);

  // Expanding the newly-imported one shows its discussion, carried over
  // correctly, not just an empty shell. GET /api/notebooks orders newest
  // first, so the just-imported notebook is the first of the two rows,
  // not the last. Clicking the heading specifically (not the row's
  // bounding-box center) avoids any risk of landing on the Export/Delete
  // buttons that share the row.
  await notebookRows.first().locator("h3").click();
  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toHaveCount(2, { timeout: 15_000 });
});

// Item 7's auto-rename: importing the same .pact file repeatedly must
// produce distinctly-named notebooks rather than a pile of
// identically-named ones. This is deliberately placeholder behavior (a
// future task replaces it with an interactive name prompt), so what's
// pinned here is only the observable outcome -- distinct names, in the
// documented "<name> 1", "<name> 2" shape -- not the mechanism.
test("importing the same .pact file twice auto-renames each collision instead of duplicating the name", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-import-rename-${suffix}@example.com`;
  const password = "correct horse battery staple 21!";
  const notebookName = `E2E import-rename notebook ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  expect(notebookError).toBeNull();

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

  const originalRow = page.getByRole("treeitem", { name: notebookName });
  await expect(originalRow).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(originalRow, notebookName, "Export"),
  ]);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  const fileInput = page.locator('input[type="file"][accept=".pact"]');

  // First import collides with the original -> "<name> 1".
  await fileInput.setInputFiles(downloadedPath!);
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 1` }),
  ).toHaveCount(1, { timeout: 15_000 });

  // Second import of the exact same file collides with both -> "<name> 2",
  // not a second "<name> 1" and not another bare "<name>".
  await fileInput.setInputFiles(downloadedPath!);
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 2` }),
  ).toHaveCount(1, { timeout: 15_000 });

  // Three rows total, each a distinct name -- no duplicates anywhere.
  const allRows = page.getByRole("treeitem", { name: notebookName });
  await expect(allRows).toHaveCount(3);
  const names = await allRows.locator("h3").allInnerTexts();
  expect(new Set(names).size).toBe(3);
  expect([...names].sort()).toEqual(
    [notebookName, `${notebookName} 1`, `${notebookName} 2`].sort(),
  );
});

// Reproduces the exact manually-reported bug: export a notebook with two
// already-run discussions, delete it, re-import the file, and confirm
// each imported discussion's composer shows its last-run prompt -- not
// just its History section (which already worked). The .pact schema
// itself has no draft/composer field (each cell only carries the prompt
// that was actually run, paired with its response) -- the fix pulls the
// composer's fallback content from history's own last cell at load time,
// in useDiscussionExecution's saveThenLoad, which both the normal
// discussion-switch path and this import-then-load path share. So the
// same fix -- not an import-specific backfill of draft_prompt_text --
// covers both.
test("after export, delete, and re-import, each discussion's composer shows its last-run prompt", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-export-delete-import-${suffix}@example.com`;
  const password = "correct horse battery staple 27!";
  const notebookName = `E2E export-delete-import notebook ${suffix}`;
  const d1Name = `Notebook-1-D1 ${suffix}`;
  const d2Name = `Notebook-1-D2 ${suffix}`;
  const d1Prompt = `d1 last prompt ${suffix}`;
  const d2Prompt = `d2 last prompt ${suffix}`;

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

  const { data: discussions, error: discussionsError } = await admin
    .from("discussions")
    .insert([
      { notebook_id: notebook!.id, user_id: userId, name: d1Name },
      { notebook_id: notebook!.id, user_id: userId, name: d2Name },
    ])
    .select();
  expect(discussionsError).toBeNull();
  const d1 = discussions!.find((d) => d.name === d1Name)!;
  const d2 = discussions!.find((d) => d.name === d2Name)!;

  // Each discussion was "previously run with a real prompt and
  // response" -- a cell, exactly like a genuine /api/execute call would
  // leave behind -- and, per the app's own post-run cleanup, no
  // separately-saved draft (draft_prompt_text defaults to null and
  // nothing here sets it).
  const { error: cellsError } = await admin.from("responses").insert([
    {
      discussion_id: d1.id,
      user_id: userId,
      prompt_text: d1Prompt,
      response: "d1 response",
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-20260101",
      cell_type: "assistant",
    },
    {
      discussion_id: d2.id,
      user_id: userId,
      prompt_text: d2Prompt,
      response: "d2 response",
      model: "claude-sonnet-4-6",
      resolved_model: "claude-sonnet-4-6-20260101",
      cell_type: "assistant",
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

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRow).toHaveCount(1);

  // 1. Export via the real Export button.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(notebookRow, notebookName, "Export"),
  ]);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  // 2. Delete the notebook via the real Delete notebook button.
  page.once("dialog", (dialog) => dialog.accept());
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/notebooks") &&
      response.request().method() === "DELETE",
  );
  await chooseRowAction(notebookRow, notebookName, "Delete notebook");
  expect((await deleteResponsePromise).status()).toBe(200);
  await expect(notebookRow).toHaveCount(0, { timeout: 15_000 });

  // 3. Re-import the exported file.
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles(downloadedPath!);
  await expect(notebookRow).toHaveCount(1, { timeout: 15_000 });

  // 4. Each imported discussion's composer must show its own last-run
  // prompt -- the actual bug -- not just its History section (already
  // working before this fix).
  await notebookRow.locator("h3").click();
  const importedD1 = page.getByRole("treeitem", { name: d1Name });
  const importedD2 = page.getByRole("treeitem", { name: d2Name });
  await expect(importedD1).toHaveCount(1, { timeout: 15_000 });
  await expect(importedD2).toHaveCount(1);

  const prompt = page.getByLabel("Prompt");

  await importedD1.click();
  await expect(page.getByText(d1Prompt).first()).toBeVisible();
  await expect(prompt).toHaveText(d1Prompt, { timeout: 10_000 });

  await importedD2.click();
  await expect(page.getByText(d2Prompt).first()).toBeVisible();
  await expect(prompt).toHaveText(d2Prompt, { timeout: 10_000 });

  // And switching back to D1 still shows D1's own prompt, not D2's --
  // this is per-discussion history, not a leftover from the last switch.
  await importedD1.click();
  await expect(prompt).toHaveText(d1Prompt, { timeout: 10_000 });
});

// Task 55d. The notebook-level totalTimeMs written into the file.
//
// Read out of the actual downloaded bytes, not out of an API response:
// the requirement is that someone opening the raw .pact a month from
// now, with no database behind it, can see how long the work took. If
// it is not in the file on disk, it does not exist for that purpose.
test("the exported file carries a notebook-level totalTimeMs, and it survives a round trip", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-rollup-export-${suffix}@example.com`;
  const password = "correct horse battery staple 55!";
  const notebookName = `E2E rollup notebook ${suffix}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    { email, password, email_confirm: true },
  );
  if (userError || !created.user) throw userError ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();

  // Known, deliberately uneven timings so the assertion cannot pass by
  // coincidence, plus a never-run discussion contributing nothing.
  await admin.from("discussions").insert([
    {
      notebook_id: notebook!.id,
      user_id: userId,
      name: `${notebookName} ran-long`,
      total_time_ms: 1234,
    },
    {
      notebook_id: notebook!.id,
      user_id: userId,
      name: `${notebookName} ran-short`,
      total_time_ms: 766,
    },
    {
      notebook_id: notebook!.id,
      user_id: userId,
      name: `${notebookName} never-ran`,
      total_time_ms: 0,
    },
  ]);
  const EXPECTED_TOTAL = 1234 + 766 + 0;

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
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(row, notebookName, "Export"),
  ]);
  const exported = JSON.parse(readFileSync((await download.path())!, "utf-8"));

  // The field is present, and is the sum of the per-discussion values
  // in the same file -- not an independently drifting number.
  expect(exported.notebook.totalTimeMs).toBe(EXPECTED_TOTAL);
  expect(exported.notebook.totalTimeMs).toBe(
    exported.discussions.reduce(
      (sum: number, d: { totalTimeMs: number }) => sum + d.totalTimeMs,
      0,
    ),
  );
  // Additive change only: the version must not have moved, or every
  // existing file and every pact-mac file stops importing.
  expect(exported.version).toBe(1);

  // Round trip: import the file back, then export the copy and confirm
  // the number is still there and still right.
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles((await download.path())!);

  const importedRow = page.getByRole("treeitem", {
    name: `${notebookName} 1`,
    exact: true,
  });
  await expect(importedRow).toBeVisible({ timeout: 15_000 });

  const [reDownload] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(importedRow, `${notebookName} 1`, "Export"),
  ]);
  const reExported = JSON.parse(
    readFileSync((await reDownload.path())!, "utf-8"),
  );
  expect(reExported.notebook.totalTimeMs).toBe(EXPECTED_TOTAL);
});

// A .pact written before task 55d has no notebook.totalTimeMs at all.
// Those files must still import -- the field is additive, not required.
test("a pre-55d .pact file, with no notebook totalTimeMs, still imports", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-legacy-pact-${suffix}@example.com`;
  const password = "correct horse battery staple 56!";
  const notebookName = `E2E legacy pact ${suffix}`;

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    { email, password, email_confirm: true },
  );
  if (userError || !created.user) throw userError ?? new Error("no user");

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
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  // Exactly the shape this app emitted before task 55d: no
  // notebook.totalTimeMs key at all.
  const legacy = {
    version: 1,
    exportedAt: Date.now(),
    notebook: {
      name: notebookName,
      systemPrompt: null,
      category: "Dev Test",
    },
    discussions: [
      {
        id: "legacy-d1",
        name: `${notebookName} d1`,
        createdAt: 1,
        totalTimeMs: 99,
      },
    ],
    cells: [],
  };
  expect("totalTimeMs" in legacy.notebook).toBe(false);

  await page.locator('input[type="file"][accept=".pact"]').setInputFiles({
    name: "legacy.pact",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacy)),
  });

  // Imports cleanly -- no validation error, notebook present in the tree.
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/isn't valid|Failed to import/i)).toHaveCount(0);
});
