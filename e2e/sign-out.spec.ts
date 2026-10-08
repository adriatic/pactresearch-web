import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 80. The Sign out button in the Account window. Runs in chromium
// and webkit-ipad (playwright.config.ts). The iPad keyboard is simulated
// through visualViewport, as in ipad-modal-height.spec.ts.

const VISIBLE_WITH_KEYBOARD = 599;

function getLocalSupabaseStatus(): {
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

declare global {
  interface Window {
    __simulatedVisualViewportHeight: number | null;
  }
}

function installKeyboardSimulation() {
  window.__simulatedVisualViewportHeight = null;
  const vv = window.visualViewport;
  if (!vv) return;
  const real = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(vv),
    "height",
  )!.get!;
  Object.defineProperty(vv, "height", {
    configurable: true,
    get: () => window.__simulatedVisualViewportHeight ?? real.call(vv),
  });
}

async function signIn(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const email = `e2e-sign-out-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "correct horse battery staple 80!";
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;

  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cookies) =>
        cookies.forEach(({ name, value }) => {
          const existing = jar.find((c) => c.name === name);
          if (existing) existing.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
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

  await page.addInitScript(installKeyboardSimulation);
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
}

async function openAccount(page: Page) {
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.setTimeout(60_000);

test("Sign out in the Account window lands on the sign-in page", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  const dialog = await openAccount(page);
  const signOut = dialog.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Sign in to PACT" }),
  ).toBeVisible();
});

test("after signing out, the notebooks cannot be reached without signing in", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  // Signed in: the notebook list answers.
  expect((await page.request.get("/api/notebooks")).status()).toBe(200);

  const dialog = await openAccount(page);
  await dialog.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The workspace sends you to sign in.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  // Back does not bring the notebooks back either.
  await page.goBack();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  // And the notebook list refuses.
  expect((await page.request.get("/api/notebooks")).status()).toBe(401);
});

test("Sign out is visible on both tabs and is a comfortable tap target", async ({
  page,
  context,
}) => {
  await signIn(page, context);
  const dialog = await openAccount(page);
  for (const tab of ["Profile", "Keys"]) {
    await dialog.getByRole("tab", { name: tab }).click();
    const signOut = dialog.getByRole("button", { name: "Sign out" });
    await expect(signOut).toBeVisible();
    const box = (await signOut.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("with the iPad keyboard up, the Account window fits and Sign out can be reached", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "webkit-ipad",
    "the keyboard check is for the iPad profile",
  );
  await signIn(page, context);
  await page.locator("header").getByRole("button", { name: "Account" }).tap();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Your name:").tap();
  await page.evaluate((height) => {
    window.__simulatedVisualViewportHeight = height;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, VISIBLE_WITH_KEYBOARD);

  // Task 75's rule still holds for this dialog.
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return box.y >= 0 && box.y + box.height <= VISIBLE_WITH_KEYBOARD;
    })
    .toBe(true);

  const signOut = dialog.getByRole("button", { name: "Sign out" });
  await signOut.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const box = (await signOut.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(VISIBLE_WITH_KEYBOARD);

  // Close is still reachable too: the rest of the window is unchanged.
  const close = dialog.getByRole("button", { name: "Close" });
  await close.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(
    VISIBLE_WITH_KEYBOARD,
  );

  await signOut.tap();
  await expect(page).toHaveURL(/\/login$/);
});

test("another website cannot sign you out by posting", async ({ request }) => {
  const response = await request.post("/logout", {
    headers: { origin: "https://evil.example" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});
