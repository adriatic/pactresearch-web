import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 44 item B, second half: a completed run must LEAVE the prompt in
// the composer, so it can be revised and resent (pact-mac's behaviour,
// and Nik's stated intent). The composer clears on switching to a
// different discussion, and on nothing else.
//
// The reload assertion is the one that matters most: before this, the
// draft was actively wiped from the database on run completion, so
// "retained" could only ever have meant "until you refresh".

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

test("a completed run leaves the prompt in the composer, and it survives a reload", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-retain-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";
  const discussionName = `E2E retain discussion ${suffix}`;
  const otherName = `E2E other discussion ${suffix}`;
  const promptText = `retain me ${suffix}`;

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
    .insert({ user_id: userId, name: `E2E retain notebook ${suffix}` })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });
  await admin
    .from("discussions")
    .insert({ notebook_id: notebook!.id, user_id: userId, name: otherName });

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

  await page.route("**/api/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        response: "# Done\n\nAn answer.",
        resolved_model: "claude-sonnet-4-6-mock",
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();

  const prompt = page.getByLabel("Prompt");
  await prompt.fill(promptText);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute")),
    page.locator("header").getByRole("button", { name: "Run" }).click(),
  ]);

  // The response arrived...
  await expect(page.locator("main")).toContainText("An answer.", {
    timeout: 15_000,
  });
  // ...and the prompt is still there, ready to revise and resend.
  await expect(prompt).toHaveText(promptText);
  await page.waitForTimeout(1200);
  await expect(prompt).toHaveText(promptText);

  // Persisted, not merely held in memory: a reload must still show it.
  // The discussion is re-selected explicitly after the reload -- the app
  // picks its own initial discussion on load, and this notebook has two,
  // so asserting on whatever it happened to choose would be testing the
  // wrong composer. (Confirmed that way round: the draft PATCH fires with
  // the right content and returns 200, it was the assertion that was
  // looking at the other discussion.)
  await page.reload();
  await page.getByRole("treeitem", { name: discussionName }).click();
  await expect(page.getByLabel("Prompt")).toHaveText(promptText, {
    timeout: 15_000,
  });

  // And the other half of the rule still holds -- switching to a
  // different discussion does clear it.
  await page.getByRole("treeitem", { name: otherName }).click();
  await expect(page.getByLabel("Prompt")).toHaveText("", { timeout: 15_000 });
});
