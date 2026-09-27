import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 51. Per-user Anthropic keys: stored encrypted, revealed only on
// request, and required before a run.
//
// FAKE_KEY is not a real credential -- it is prefix-valid so it passes
// the route's format check, and nothing else.

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

const FAKE_KEY = "sk-ant-api03-E2E-FAKE-KEY-not-real-0123456789abcdefgh";
const MISSING_KEY_TEXT = /Add your Anthropic API key in Account/i;

test.setTimeout(90_000);

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-keys-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const discussionName = `E2E keys discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw userErr ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: `E2E keys notebook ${suffix}` })
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

  return { admin, userId };
}

async function openKeysTab(page: Page) {
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Keys" }).click();
  return dialog;
}

test("a key saves, is stored ENCRYPTED at rest, and reveals only on request", async ({
  page,
  context,
}) => {
  const { admin, userId } = await seed(page, context);
  const dialog = await openKeysTab(page);

  // No OpenAI field anywhere -- explicitly out of scope.
  await expect(dialog.getByText(/openai/i)).toHaveCount(0);
  await expect(
    dialog.getByRole("link", { name: /console\.anthropic\.com/ }),
  ).toBeVisible();

  const field = dialog.getByLabel("Anthropic API key:");
  // Masked by default.
  await expect(field).toHaveAttribute("type", "password");

  // Format is checked before anything is stored.
  await field.fill("not-an-anthropic-key");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText(/starts with "sk-ant-"/)).toBeVisible();

  await field.fill(FAKE_KEY);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("API key saved.")).toBeVisible();

  // THE POINT OF THE TASK: what landed in the database is not the key.
  // Read straight from the row, bypassing the app entirely.
  const { data: row } = await admin
    .from("user_api_keys")
    .select("anthropic_key_encrypted")
    .eq("user_id", userId)
    .single();
  const stored = row!.anthropic_key_encrypted as string;
  expect(stored).toBeTruthy();
  expect(stored).not.toContain(FAKE_KEY);
  expect(stored).not.toContain("sk-ant");
  // And not merely encoded: decoding each base64 segment must not
  // reveal it either.
  for (const part of stored.split(":").slice(1)) {
    expect(Buffer.from(part, "base64").toString("utf8")).not.toContain(
      "sk-ant",
    );
  }
  expect(stored.startsWith("v1:")).toBe(true);

  // Show / hide round trip, including a fresh dialog where the plaintext
  // has to come back from the server.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  const reopened = await openKeysTab(page);
  const reopenedField = reopened.getByLabel("Anthropic API key:");
  await expect(reopenedField).toHaveAttribute("type", "password");
  // Empty field, but it knows a key exists.
  await expect(reopenedField).toHaveAttribute("placeholder", /Saved/);

  await reopened.getByRole("button", { name: "Show" }).click();
  await expect(reopenedField).toHaveAttribute("type", "text");
  await expect(reopenedField).toHaveValue(FAKE_KEY);

  await reopened.getByRole("button", { name: "Hide" }).click();
  await expect(reopenedField).toHaveAttribute("type", "password");
});

test("running with no key shows the blocking message, not a raw API error", async ({
  page,
  context,
}) => {
  await seed(page, context);

  await page.getByLabel("Prompt").fill("a prompt that should be blocked");
  await page.locator("header").getByRole("button", { name: "Run" }).click();

  // Scoped to the response panel: the composer surfaces its own
  // alert for upload errors, so an unscoped role="alert" matches two.
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toHaveText(MISSING_KEY_TEXT);

  // Not a raw upstream error leaking through.
  await expect(alert).not.toHaveText(/ANTHROPIC_API_KEY/);
  await expect(alert).not.toHaveText(/x-api-key|401|Unauthorized/i);
});

test("with a key stored, the run gets past the key gate", async ({
  page,
  context,
}) => {
  const { admin, userId } = await seed(page, context);

  const dialog = await openKeysTab(page);
  await dialog.getByLabel("Anthropic API key:").fill(FAKE_KEY);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("API key saved.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByLabel("Prompt").fill("a prompt that reaches Anthropic");
  await page.locator("header").getByRole("button", { name: "Run" }).click();

  // The run is expected to FAIL -- FAKE_KEY is not a real credential --
  // but it must fail at Anthropic, not at our gate. Asserting the
  // absence of the blocking message is what proves the stored key was
  // found, decrypted, and used. Deliberately does not depend on what
  // Anthropic (or an offline network) returns.
  // Scoped to the response panel: the composer surfaces its own
  // alert for upload errors, so an unscoped role="alert" matches two.
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).not.toHaveText(MISSING_KEY_TEXT);

  // The key really is on the row for this user, and still encrypted.
  const { data: row } = await admin
    .from("user_api_keys")
    .select("anthropic_key_encrypted")
    .eq("user_id", userId)
    .single();
  expect(row!.anthropic_key_encrypted).not.toContain("sk-ant");
});

// The 2026-09-27 misdiagnosis, pinned.
//
// When the server cannot decrypt a stored key it answers this endpoint
// with a 500 and an explanation. The Keys tab used to ignore the status
// entirely, so Boolean(undefined) made hasKey false and the field
// rendered empty and silent -- indistinguishable from never having
// saved a key. That is what sent a production investigation looking for
// a deleted database row that was in fact still there.
test("an unreadable stored key is reported as unreadable, not as no key at all", async ({
  page,
  context,
}) => {
  await seed(page, context);

  // Exactly what the route returns when decryption fails (see the
  // decrypt catch in app/api/account/anthropic-key/route.ts).
  await page.route("**/api/account/anthropic-key", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Your saved key could not be read. Please re-enter and save it.",
      }),
    });
  });

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();

  // It must say so...
  await expect(
    dialog.getByText(
      "Your saved key could not be read. Please re-enter and save it.",
    ),
  ).toBeVisible({ timeout: 15_000 });

  // ...and must not claim the key is fine either. "Saved (hint)" is the
  // placeholder shown when a key is readable; it must be absent here.
  //
  // The "sk-ant-..." placeholder IS still correct in this state and is
  // deliberately not asserted against: the user has just been told to
  // re-enter their key, and that is the hint for doing so. The defect
  // being fixed was the silence, not the placeholder -- an empty field
  // with no message read as "no key saved", and the same field with an
  // explanation above it reads as "re-enter it", which is the truth.
  await expect(dialog.getByPlaceholder(/^Saved \(/)).toHaveCount(0);

  // The field stays usable, so the remedy the message asks for is
  // actually available.
  await expect(dialog.getByLabel("Anthropic API key:")).toBeEnabled();
});
