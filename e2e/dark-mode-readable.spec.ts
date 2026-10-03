import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 75 follow-up. On Nik's iPad, which is set to dark mode, every
// toolbar button looked greyed out: a dark block left over from the
// Create Next App template turned body text near-white (#ededed) while the
// buttons kept their light #f0f0f0 background, so the labels all but
// vanished. The app is light-only (dialogs, menus and the transcript all
// hard-code light backgrounds), so a device in dark mode must get the same
// readable page as one in light mode.

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

test.use({ colorScheme: "dark" });
test.setTimeout(60_000);

test("in dark mode the toolbar buttons stay readable", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-dark-mode-${suffix}@example.com`;
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

  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  // WCAG contrast ratio between each button's label and its background.
  const contrasts = await page.evaluate(() => {
    function luminance(rgb: string) {
      const [r, g, b] = rgb
        .match(/\d+(\.\d+)?/g)!
        .slice(0, 3)
        .map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    return [...document.querySelectorAll("header button")].map((el) => {
      const style = getComputedStyle(el);
      const a = luminance(style.color);
      const b = luminance(style.backgroundColor);
      return {
        label: el.textContent,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });

  expect(contrasts.map((c) => c.label)).toEqual([
    "New Notebook",
    "Run",
    "Import",
    "Settings",
    "Account",
    "Model",
  ]);
  for (const { label, ratio } of contrasts) {
    expect(ratio, `${label} label contrast`).toBeGreaterThanOrEqual(4.5);
  }
});
