import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 43 item 2. The Explorer / NotebookCreator boundary inside the
// sidebar was a plain <hr>: decorative, not draggable, so the tree and
// the creator form could not trade space. It is now a real
// react-resizable-panels Separator.
//
// Scoped through the sidebar panel rather than by [data-separator]
// alone -- there are three separators on the page now (see
// explorer-resize.spec.ts, which had been failing on exactly that
// ambiguity), and this one is the only one nested inside the sidebar.

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

test("the sidebar's Explorer/NotebookCreator boundary is a real draggable divider, not an <hr>", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-sidebar-divider-${suffix}@example.com`;
  const password = "correct horse battery staple 13!";

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
    .insert({ user_id: userId, name: `E2E divider notebook ${suffix}` })
    .select()
    .single();
  expect(notebookError).toBeNull();
  const { error: discussionError } = await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: `E2E divider discussion ${suffix}`,
  });
  expect(discussionError).toBeNull();

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

  const sidebar = page.locator("[data-panel]").first();
  await expect(sidebar).toBeVisible();

  // The decorative <hr> is gone, replaced rather than merely hidden.
  await expect(sidebar.locator("hr")).toHaveCount(0);

  const divider = sidebar.locator("[data-separator]");
  await expect(divider).toBeVisible();

  const explorerPanel = sidebar.locator("[data-panel]").first();
  const initialHeight = (await explorerPanel.boundingBox())!.height;

  const box = (await divider.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // Drag upward by a definite amount and confirm the Explorer panel
  // actually shrank by roughly that much -- not merely that "a resize
  // happened".
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - 120);
  await page.mouse.up();

  const shrunkHeight = (await explorerPanel.boundingBox())!.height;
  expect(shrunkHeight).toBeLessThan(initialHeight - 60);

  // And back down again, so this is a real two-way divider rather than a
  // one-shot collapse.
  const afterBox = (await divider.boundingBox())!;
  await page.mouse.move(
    afterBox.x + afterBox.width / 2,
    afterBox.y + afterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(afterBox.x + afterBox.width / 2, startY + 60);
  await page.mouse.up();

  const regrownHeight = (await explorerPanel.boundingBox())!.height;
  expect(regrownHeight).toBeGreaterThan(shrunkHeight);

  // minSize={96} on the NotebookCreator panel must clamp, so dragging to
  // the bottom cannot swallow the creator form entirely.
  const creatorPanel = sidebar.locator("[data-panel]").last();
  const lastBox = (await divider.boundingBox())!;
  await page.mouse.move(
    lastBox.x + lastBox.width / 2,
    lastBox.y + lastBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width / 2, startY + 2000);
  await page.mouse.up();

  expect((await creatorPanel.boundingBox())!.height).toBeGreaterThanOrEqual(90);
});
