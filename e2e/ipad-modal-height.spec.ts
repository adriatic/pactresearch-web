import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// On Nik's iPad the New notebook dialog was taller than the visible area,
// so its Cancel button sat below the bottom edge with no way to reach it:
// the dialog had no height limit and its overlay is position: fixed, so
// nothing could scroll. Tapping the Name field raises the keyboard, which
// takes away a further 159px in landscape.
//
// Runs in the webkit-ipad project (1080x758, iPadOS Chrome's visible area
// in landscape). The keyboard is simulated through visualViewport, as in
// ipad-keyboard-viewport.spec.ts.

const VISIBLE_WITH_KEYBOARD = 599;

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

async function setKeyboard(page: Page, open: boolean) {
  await page.evaluate(
    ({ height }) => {
      window.__simulatedVisualViewportHeight = height;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    },
    { height: open ? VISIBLE_WITH_KEYBOARD : null },
  );
}

test.setTimeout(60_000);

test("the New notebook dialog fits above the keyboard and Cancel can be reached", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-ipad-modal-${suffix}@example.com`;
  const password = "correct horse battery staple 75!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }

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

  await page.addInitScript(installKeyboardSimulation);
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  await page.getByRole("button", { name: "New Notebook" }).tap();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Name:").tap();
  await setKeyboard(page, true);

  // The whole dialog box sits inside what is visible above the keyboard.
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return box.y >= 0 && box.y + box.height <= VISIBLE_WITH_KEYBOARD;
    })
    .toBe(true);

  // Cancel, the last thing in it, can be scrolled to inside the dialog and
  // then lies within the visible area.
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await cancel.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const cancelBox = (await cancel.boundingBox())!;
  expect(cancelBox.y).toBeGreaterThanOrEqual(0);
  expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(
    VISIBLE_WITH_KEYBOARD,
  );

  // And it works.
  await cancel.tap();
  await expect(dialog).toHaveCount(0);
});
