import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// Task 76. Nik's magic link bounced him back to the email form in Safari
// on his iPad, with no explanation. These run the real flow against the
// local stack -- request a link from /login, read the actual email from
// Mailpit, open its link -- in both the chromium and webkit-ipad projects
// (playwright.config.ts), so WebKit's cookie handling is exercised, not
// just Chromium's.
//
// Each failure case must land on /login with the message for its cause.
// The codes behind them were captured from this same local stack: a link
// loaded once already returns otp_expired, and a link opened in a browser
// that never requested it fails the exchange with
// pkce_code_verifier_not_found.

const MAILPIT = "http://127.0.0.1:54324";

interface LocalSupabaseStatus {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

function uniqueEmail(label: string) {
  return `e2e-magic-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

// Requests a link through the real form and returns the URL from the
// email Supabase actually sent.
async function requestLink(page: Page, email: string): Promise<string> {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  let link: string | null = null;
  await expect(async () => {
    const search = await (
      await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      )
    ).json();
    expect(search.messages?.length).toBeGreaterThan(0);
    const message = await (
      await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)
    ).json();
    const match = (message.HTML as string).match(
      /href="([^"]*\/auth\/v1\/verify[^"]*)"/,
    );
    expect(match).not.toBeNull();
    link = match![1].replace(/&amp;/g, "&");
  }).toPass({ timeout: 15_000 });
  return link!;
}

// Scoped to <main>: Next's own route announcer is also role="alert"
// (app-router-announcer.js), so an unscoped getByRole matches two.
const alert = (page: Page) => page.locator("main").getByRole("alert");

test.setTimeout(60_000);

test("a link opened in the browser that requested it signs in", async ({
  page,
}) => {
  const link = await requestLink(page, uniqueEmail("same"));
  await page.goto(link);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
});

test("a link that was already used explains itself", async ({ page }) => {
  const link = await requestLink(page, uniqueEmail("used"));
  // What a link preview or an email scanner does: one plain GET, which is
  // enough to spend the token.
  await fetch(link, { redirect: "manual" });

  await page.goto(link);

  await expect(page).toHaveURL(/\/login\?error=link_expired/);
  await expect(alert(page)).toContainText("expired or was already used");
  await expect(alert(page)).not.toContainText("otp_expired");
});

test("an expired link explains itself", async ({ page }) => {
  const { API_URL, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const email = uniqueEmail("expired");
  const { error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  expect(error).toBeNull();

  const link = await requestLink(page, email);
  // Backdate the send time past the one-hour expiry instead of waiting.
  execFileSync("docker", [
    "exec",
    "supabase_db_pactresearch-web",
    "psql",
    "-U",
    "postgres",
    "-c",
    `update auth.users set recovery_sent_at = now() - interval '2 hours',
       confirmation_sent_at = now() - interval '2 hours'
     where email = '${email}'`,
  ]);

  await page.goto(link);

  await expect(page).toHaveURL(/\/login\?error=link_expired/);
  await expect(alert(page)).toContainText("expired or was already used");
});

test("a link opened in a different browser says to use the original one", async ({
  page,
  browser,
}) => {
  const link = await requestLink(page, uniqueEmail("other"));

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto(link);

  await expect(other).toHaveURL(/\/login\?error=other_browser/);
  await expect(alert(other)).toContainText("different browser");
  await otherContext.close();
});

test("an unknown error value shows no message", async ({ page }) => {
  await page.goto("/login?error=%3Cscript%3E");
  await expect(
    page.getByRole("heading", { name: "Sign in to PACT" }),
  ).toBeVisible();
  await expect(alert(page)).toHaveCount(0);
});
