import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 50. Account profile, per-notebook system prompt (including the
// real "Refine with AI" call), and the model tier picker.
//
// /api/refine-system-prompt is mocked at the browser network layer for
// the same reason /api/execute is in the other specs: no
// ANTHROPIC_API_KEY locally, and the client path being tested -- send,
// in-flight state, fill the textarea, then Save -- is identical either
// way. The route's own logic is exercised by its 400 path, which needs
// no key.

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

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-acct-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const notebookName = `E2E acct notebook ${suffix}`;
  const discussionName = `E2E acct discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw userErr ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });

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

  return { admin, userId, notebookId: notebook!.id, email, suffix };
}

test("Item A: profile saves and is still there when the dialog is reopened", async ({
  page,
  context,
}) => {
  const { admin, userId, email, suffix } = await seed(page, context);
  const name = `Ada ${suffix}`;
  const useCase = "Reviewing contracts for ambiguous liability clauses.";

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();

  // The Keys tab is present but disabled -- task 51's slot.
  await expect(dialog.getByRole("tab", { name: "Keys" })).toBeDisabled();
  // The inaccurate pact-mac subtitle must not appear.
  await expect(page.getByText(/saved immediately/i)).toHaveCount(0);

  // Email prefills from the sign-in address.
  await expect(dialog.getByLabel("Email address:")).toHaveValue(email);

  await dialog.getByLabel("Your name:").fill(name);
  await dialog
    .getByLabel("What will you use PACT for? (optional)")
    .fill(useCase);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Profile saved.")).toBeVisible();

  // Persisted server-side, not just held in the component.
  const { data: after } = await admin.auth.admin.getUserById(userId);
  expect(after.user?.user_metadata?.full_name).toBe(name);
  expect(after.user?.user_metadata?.pact_use_case).toBe(useCase);

  // And it reloads: close, reopen, the values are re-fetched.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  await expect(dialog.getByLabel("Your name:")).toHaveValue(name);
  await expect(
    dialog.getByLabel("What will you use PACT for? (optional)"),
  ).toHaveValue(useCase);
});

test("Item B: Refine with AI fills the system prompt, and Save persists it", async ({
  page,
  context,
}) => {
  const { admin, notebookId, suffix } = await seed(page, context);
  const drafted = `You are reviewing oncology trial protocols. ${suffix}`;

  let sentDescription: string | null = null;
  await page.route("**/api/refine-system-prompt", async (route) => {
    sentDescription = (
      route.request().postDataJSON() as { description: string }
    ).description;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ systemPrompt: drafted }),
    });
  });

  await page
    .locator("header")
    .getByRole("button", { name: "Settings" })
    .click();
  const dialog = page.getByRole("heading", { name: "Notebook settings" });
  await expect(dialog).toBeVisible();

  // The reworded, accurate subtitle -- not pact-mac's false claim.
  await expect(page.getByText(/saved immediately/i)).toHaveCount(0);
  await expect(
    page.getByText(/applies to every prompt run in this notebook/i),
  ).toBeVisible();

  // Send is inert until there is something to refine.
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();

  const description = "Oncology trial protocol review";
  await page
    .getByPlaceholder("Describe your research domain...")
    .fill(description);
  await expect(send).toBeEnabled();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/refine-system-prompt")),
    send.click(),
  ]);

  // The draft landed in the editable field -- and was NOT auto-saved.
  const textarea = page.getByLabel("System prompt:");
  await expect(textarea).toHaveValue(drafted);
  expect(sentDescription).toBe(description);
  const { data: midway } = await admin
    .from("notebooks")
    .select("system_prompt")
    .eq("id", notebookId)
    .single();
  expect(midway!.system_prompt ?? "").not.toBe(drafted);

  // Manual edit on top of the draft, then an explicit Save.
  const edited = `${drafted} Flag anything unusual.`;
  await textarea.fill(edited);
  await page.getByRole("button", { name: "Save" }).click();

  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("notebooks")
          .select("system_prompt")
          .eq("id", notebookId)
          .single();
        return data!.system_prompt;
      },
      { timeout: 15_000 },
    )
    .toBe(edited);
});

test("Item C: choosing a tier applies immediately; Cancel changes nothing", async ({
  page,
  context,
}) => {
  const { admin, userId } = await seed(page, context);

  const tierOf = async () => {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data.user?.user_metadata?.model_tier ?? null;
  };

  // Nothing set to begin with.
  expect(await tierOf()).toBeNull();

  // Cancel is a genuine no-op.
  await page.locator("header").getByRole("button", { name: "Model" }).click();
  const dialog = page.getByRole("dialog", { name: "Model tier" });
  await expect(dialog).toBeVisible();
  // Neither tier is pre-selected: they are plain choices, not a
  // reflection of current state.
  await expect(dialog.getByRole("button", { name: /Standard/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Economy/ })).toBeVisible();
  await expect(dialog).toContainText("claude-sonnet-5");
  await expect(dialog).toContainText("claude-haiku-4-5");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await tierOf()).toBeNull();

  // Selecting applies right away and closes -- no Save button exists.
  await page.locator("header").getByRole("button", { name: "Model" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save" })).toHaveCount(0);
  await dialog.getByRole("button", { name: /Economy/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  await expect.poll(tierOf, { timeout: 15_000 }).toBe("economy");
});

test("Item C regression: the dialog is still usable after a successful selection", async ({
  page,
  context,
}) => {
  // Reported from production: the modal showed "Standard — applying..."
  // and froze, with no way to dismiss it.
  //
  // The cause was state surviving a close. Choosing a tier set
  // `applying` and the success path called onClose(), but closing only
  // makes the component render null -- it stays mounted, so `applying`
  // was still set on the next open. Every tier button and Cancel are
  // gated on it, so the whole dialog was inert and stuck mid-apply.
  //
  // Not specific to re-selecting the same tier, though that is how it
  // was hit: ANY successful selection left it that way. Task 50's spec
  // missed it because it only ever selected once. This exercises all
  // three follow-on paths.
  const { admin, userId } = await seed(page, context);

  const tierOf = async () => {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data.user?.user_metadata?.model_tier ?? null;
  };
  const dialog = page.getByRole("dialog", { name: "Model tier" });
  const openDialog = async () => {
    await page.locator("header").getByRole("button", { name: "Model" }).click();
    await expect(dialog).toBeVisible();
  };

  // First selection -- the one that used to poison the state.
  await openDialog();
  await dialog.getByRole("button", { name: /Standard/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect.poll(tierOf, { timeout: 15_000 }).toBe("standard");

  // Reopening must not show a stale "applying" state, and everything
  // must be interactive again.
  await openDialog();
  await expect(dialog).not.toContainText("applying");
  await expect(dialog.getByRole("button", { name: /Standard/ })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: /Economy/ })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();

  // Cancel still works -- it was disabled too, which is why the modal
  // could not be dismissed at all.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await tierOf()).toBe("standard");

  // Re-selecting the tier that is ALREADY active applies and closes.
  await openDialog();
  await dialog.getByRole("button", { name: /Standard/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(await tierOf()).toBe("standard");

  // And switching to the other tier afterwards still works.
  await openDialog();
  await dialog.getByRole("button", { name: /Economy/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect.poll(tierOf, { timeout: 15_000 }).toBe("economy");
});
