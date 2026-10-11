import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 81 Stage 2, from Nik's Preview test of 0675cf1: he could not find
// the provider dropdown. In a window narrower than about 1,075px the top
// bar wrapped between Model and the dropdown, leaving Model last on the
// first line and the dropdown alone at the start of a second line. The
// dropdown must sit right after Model, on the same line, at every width,
// labelled "Provider:". Runs in chromium and webkit-ipad
// (playwright.config.ts).

test.setTimeout(90_000);

test.beforeEach(async ({ page, context }) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const email = `e2e-provider-layout-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "provider layout e2e 81!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
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
  await client.auth.signInWithPassword({ email, password });
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
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
});

for (const width of [1512, 1280, 1100, 1024, 900, 800]) {
  test(`at ${width}px wide, the provider dropdown sits right after Model, labelled`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const header = page.locator("header");
    const model = header.getByRole("button", { name: "Model" });
    const dropdown = header.getByRole("combobox", { name: "Provider" });
    await expect(dropdown).toBeVisible();
    await expect(header.getByText("Provider:")).toBeVisible();
    await expect(dropdown.locator("option:checked")).toHaveText(
      "Claude · claude-sonnet-5",
    );

    const m = (await model.boundingBox())!;
    const d = (await dropdown.boundingBox())!;
    // Same line: their vertical middles agree.
    expect(Math.abs(m.y + m.height / 2 - (d.y + d.height / 2))).toBeLessThan(8);
    // Right after Model: to its right, with only the "Provider:" label
    // between them.
    expect(d.x).toBeGreaterThan(m.x + m.width);
    expect(d.x - (m.x + m.width)).toBeLessThan(110);
    // And wholly inside the window.
    expect(d.x + d.width).toBeLessThanOrEqual(width);
  });
}
