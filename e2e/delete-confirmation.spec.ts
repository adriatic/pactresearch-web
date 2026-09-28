import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// The confirmation gate on Delete.
//
// It has existed since the Explorer was first built, but nothing ever
// tested it: seven specs accept the dialog to get past it, and not one
// asserts what it says or that dismissing it actually cancels. So
// "cancel leaves the notebook untouched" was believed rather than
// known, and the message could have drifted to say anything at all.
//
// The count in the message is new. "and all its discussions" read the
// same for a notebook with eleven as for one with none.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
}

test.setTimeout(90_000);

async function seed(
  page: Page,
  context: BrowserContext,
  discussionCount: number,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-delconf-${suffix}@example.com`;
  const password = "correct horse battery staple 61!";
  const notebookName = `E2E delconf notebook ${suffix}`;

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

  for (let i = 0; i < discussionCount; i++) {
    await admin.from("discussions").insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: `E2E delconf discussion ${i} ${suffix}`,
    });
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
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  return { admin, notebookId: notebook!.id, notebookName, userId };
}

test("the confirmation names the notebook, states the blast radius, and says it is permanent", async ({
  page,
  context,
}) => {
  const { notebookName } = await seed(page, context, 3);

  let message = "";
  page.once("dialog", (dialog) => {
    message = dialog.message();
    return dialog.dismiss();
  });

  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await chooseRowAction(row, notebookName, "Delete notebook");
  await expect.poll(() => message).not.toBe("");

  expect(message).toContain(notebookName);
  expect(message).toContain("3 discussions");
  expect(message).toMatch(/cannot be undone/i);
});

test("one discussion reads as singular, and none says so plainly", async ({
  page,
  context,
}) => {
  const single = await seed(page, context, 1);
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    return d.dismiss();
  });
  await chooseRowAction(
    page.getByRole("treeitem", { name: single.notebookName, exact: true }),
    single.notebookName,
    "Delete notebook",
  );
  await expect.poll(() => message).not.toBe("");
  expect(message).toContain("1 discussion.");
  // Not "1 discussions".
  expect(message).not.toContain("1 discussions");
});

test("an empty notebook says it has none, rather than '0 discussions'", async ({
  page,
  context,
}) => {
  const empty = await seed(page, context, 0);
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    return d.dismiss();
  });
  await chooseRowAction(
    page.getByRole("treeitem", { name: empty.notebookName, exact: true }),
    empty.notebookName,
    "Delete notebook",
  );
  await expect.poll(() => message).not.toBe("");
  expect(message).toMatch(/no discussions/i);
  expect(message).not.toContain("0 discussion");
});

// The path nothing has ever tested. Every other delete spec accepts the
// dialog; none dismisses it, so "cancel leaves it untouched" has been
// an assumption for the life of the feature.
test("cancelling leaves the notebook AND its discussions untouched", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName, userId } = await seed(
    page,
    context,
    2,
  );

  page.once("dialog", (dialog) => dialog.dismiss());
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await chooseRowAction(row, notebookName, "Delete notebook");

  // Still on screen...
  await expect(row).toBeVisible();

  // ...and still in the database, with its discussions. Checked
  // directly, because a row lingering in a stale tree would look
  // identical to one that was never deleted.
  const { data: notebooks } = await admin
    .from("notebooks")
    .select("id")
    .eq("id", notebookId);
  expect(notebooks).toHaveLength(1);

  const { data: discussions } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(discussions).toHaveLength(2);

  // And a reload proves it, rather than trusting the client's own view.
  await page.reload();
  await expect(
    page.getByRole("treeitem", { name: notebookName, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  expect(userId).toBeTruthy();
});

test("confirming still deletes the notebook and its discussions", async ({
  page,
  context,
}) => {
  const { admin, notebookId, notebookName } = await seed(page, context, 2);

  page.once("dialog", (dialog) => dialog.accept());
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await chooseRowAction(row, notebookName, "Delete notebook");

  await expect(row).toHaveCount(0, { timeout: 15_000 });

  const { data: notebooks } = await admin
    .from("notebooks")
    .select("id")
    .eq("id", notebookId);
  expect(notebooks).toHaveLength(0);

  const { data: discussions } = await admin
    .from("discussions")
    .select("id")
    .eq("notebook_id", notebookId);
  expect(discussions).toHaveLength(0);
});
