import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Postgres's own ON DELETE CASCADE never reaches Supabase Storage --
// deleting a discussion or notebook must explicitly clean up the
// prompt-images objects it held, or they become permanent, invisible
// orphans (see the design doc's own reasoning). Checks the bucket
// directly, not just that the DB rows are gone.

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

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

async function signIn(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  API_URL: string,
  ANON_KEY: string,
  email: string,
  password: string,
) {
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
  const { error } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
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
}

async function uploadFakePromptImage(
  admin: SupabaseClient,
  userId: string,
  discussionId: string,
): Promise<string> {
  const path = `${userId}/${discussionId}/${crypto.randomUUID()}.png`;
  const { error } = await admin.storage
    .from("prompt-images")
    .upload(path, TINY_PNG_BYTES, { contentType: "image/png" });
  expect(error).toBeNull();
  return path;
}

async function listPrefix(admin: SupabaseClient, prefix: string) {
  const { data, error } = await admin.storage
    .from("prompt-images")
    .list(prefix);
  expect(error).toBeNull();
  return data ?? [];
}

test.setTimeout(30_000);

test("deleting a discussion removes its prompt-images from storage, not just its database rows", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-image-cleanup-disc-${suffix}@example.com`;
  const password = "correct horse battery staple 53!";
  const notebookName = `E2E image-cleanup-disc notebook ${suffix}`;
  const discussionName = `E2E image-cleanup-disc discussion ${suffix}`;

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
  const { data: discussion } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();

  const imagePath = await uploadFakePromptImage(admin, userId, discussion!.id);
  const prefix = `${userId}/${discussion!.id}`;
  expect(await listPrefix(admin, prefix)).toHaveLength(1);

  await signIn(page, context, API_URL, ANON_KEY, email, password);
  await page.goto("/");

  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });

  page.once("dialog", (dialog) => dialog.accept());
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/discussions") &&
      response.request().method() === "DELETE",
  );
  await discussionRow
    .getByRole("button", { name: "Delete discussion" })
    .click();
  expect((await deleteResponsePromise).status()).toBe(200);
  await expect(discussionRow).toHaveCount(0, { timeout: 10_000 });

  // The real check: the object is gone from the bucket, not merely that
  // the discussion row (and its cascade-deleted children) are gone.
  expect(await listPrefix(admin, prefix)).toHaveLength(0);

  const { data: stillThere } = await admin.storage
    .from("prompt-images")
    .download(imagePath);
  expect(stillThere).toBeNull();
});

test("deleting a notebook removes prompt-images for every discussion it contained", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-image-cleanup-nb-${suffix}@example.com`;
  const password = "correct horse battery staple 54!";
  const notebookName = `E2E image-cleanup-nb notebook ${suffix}`;
  const discussionAName = `E2E image-cleanup-nb discussion A ${suffix}`;
  const discussionBName = `E2E image-cleanup-nb discussion B ${suffix}`;

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
  const { data: discussions } = await admin
    .from("discussions")
    .insert([
      { notebook_id: notebook!.id, user_id: userId, name: discussionAName },
      { notebook_id: notebook!.id, user_id: userId, name: discussionBName },
    ])
    .select();
  const discussionA = discussions!.find((d) => d.name === discussionAName)!;
  const discussionB = discussions!.find((d) => d.name === discussionBName)!;

  await uploadFakePromptImage(admin, userId, discussionA.id);
  await uploadFakePromptImage(admin, userId, discussionB.id);
  const prefixA = `${userId}/${discussionA.id}`;
  const prefixB = `${userId}/${discussionB.id}`;
  expect(await listPrefix(admin, prefixA)).toHaveLength(1);
  expect(await listPrefix(admin, prefixB)).toHaveLength(1);

  await signIn(page, context, API_URL, ANON_KEY, email, password);
  await page.goto("/");

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });

  page.once("dialog", (dialog) => dialog.accept());
  const deleteResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/notebooks") &&
      response.request().method() === "DELETE",
  );
  await notebookRow.getByRole("button", { name: "Delete notebook" }).click();
  expect((await deleteResponsePromise).status()).toBe(200);
  await expect(notebookRow).toHaveCount(0, { timeout: 10_000 });

  expect(await listPrefix(admin, prefixA)).toHaveLength(0);
  expect(await listPrefix(admin, prefixB)).toHaveLength(0);
});
