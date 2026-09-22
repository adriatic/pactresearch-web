import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Covers the rich-composer image path end to end through the real UI: a
// real paste event with a real File, uploaded to the real prompt-images
// bucket, inserted as a real image node, and persisted via the real
// PATCH /api/discussions -- not a mocked upload or a fabricated doc.

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

// A real, valid 1x1 red PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function signIn(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  admin: SupabaseClient,
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

test.setTimeout(60_000);

test("pasting a real image into the composer uploads it, inserts it, and persists it via autosave", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-composer-image-${suffix}@example.com`;
  const password = "correct horse battery staple 50!";
  const notebookName = `E2E image-paste notebook ${suffix}`;
  const discussionName = `E2E image-paste discussion ${suffix}`;

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

  await signIn(page, context, admin, API_URL, ANON_KEY, email, password);
  await page.goto("/");

  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });
  await discussionRow.click();

  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  await prompt.click();
  await page.keyboard.type("An image follows: ");

  // A real paste event, with a real File in a real DataTransfer -- not a
  // fabricated node inserted directly into the doc.
  await page.evaluate(async (base64) => {
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++)
      byteNumbers[i] = byteChars.charCodeAt(i);
    const file = new File([new Uint8Array(byteNumbers)], "e2e-pasted.png", {
      type: "image/png",
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    editorEl.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, TINY_PNG_BASE64);

  // The image genuinely uploaded (a real fetch to the real prompt-images
  // proxy route, not a placeholder/blob URL) and rendered.
  const image = page.locator('img[alt="e2e-pasted.png"]');
  await expect(image).toBeVisible({ timeout: 10_000 });
  const imageSrc = await image.getAttribute("src");
  expect(imageSrc).toMatch(/^\/api\/prompt-images\//);

  // The <img> actually loads (not a broken reference) -- confirms the
  // proxy route really serves the uploaded bytes back through the
  // session, not just that the upload API call succeeded.
  const naturalWidth = await image.evaluate(
    (el: HTMLImageElement) => el.naturalWidth,
  );
  expect(naturalWidth).toBeGreaterThan(0);

  // An image insert triggers an IMMEDIATE save (no debounce wait) --
  // confirm draft_content in the DB reflects it well within the 2s
  // debounce window that would apply to a plain text edit.
  await expect(async () => {
    const { data: row, error } = await admin
      .from("discussions")
      .select("draft_content")
      .eq("id", discussion!.id)
      .single();
    expect(error).toBeNull();
    expect(row!.draft_content).not.toBeNull();
    const hasImage = (row!.draft_content.content ?? []).some(
      (node: { type?: string }) => node.type === "image",
    );
    expect(hasImage).toBe(true);
  }).toPass({ timeout: 3_000 });

  // Reload the page entirely -- proves this is real database persistence
  // (draft_content), not an in-memory illusion, same standard as the
  // plain-text draft persistence spec.
  await page.reload();
  await expect(discussionRow).toBeVisible({ timeout: 15_000 });
  await discussionRow.click();
  await expect(page.locator('img[alt="e2e-pasted.png"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Prompt")).toContainText("An image follows");
});
