import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// Task 76 follow-up C1. New-form sign-in links (token_hash) land on
// /auth/confirm, which shows a Sign in button; only the button spends the
// link. Runs in chromium and webkit-ipad (playwright.config.ts).
//
// The local email template (supabase/templates/magic_link.html) carries the
// new link as id="confirm" and, for magic-link-sign-in.spec.ts, the old one
// as id="legacy".

const MAILPIT = "http://127.0.0.1:54324";

function getLocalSupabaseStatus(): {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
} {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
}

const uniqueEmail = (label: string) =>
  `e2e-confirm-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

// Requests a link through the real form; returns the new-form link from
// the email Supabase actually sent.
async function requestLink(page: Page, email: string): Promise<string> {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  let link = "";
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
    const match = (message.HTML as string).match(/id="confirm" href="([^"]+)"/);
    expect(match).not.toBeNull();
    link = match![1].replace(/&amp;/g, "&");
  }).toPass({ timeout: 15_000 });
  return link;
}

async function openAndSignIn(page: Page, link: string) {
  await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/confirm\?/);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function expectSignedIn(page: Page) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
}

const alert = (page: Page) => page.locator("main").getByRole("alert");

test.setTimeout(60_000);

test("same browser: the link opens a Sign in page, and the button signs in", async ({
  page,
}) => {
  const link = await requestLink(page, uniqueEmail("same"));
  expect(new URL(link).pathname).toBe("/auth/callback");
  await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/confirm\?/);
  await expect(
    page.getByText("Press the button to finish signing in."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectSignedIn(page);
});

test("a different browser: the link still signs in", async ({
  page,
  browser,
}) => {
  const link = await requestLink(page, uniqueEmail("other"));
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await openAndSignIn(other, link);
  await expectSignedIn(other);
  await otherContext.close();
});

test("a link preview that only loads the page does not use the link up", async ({
  page,
}) => {
  const link = await requestLink(page, uniqueEmail("preview"));
  // What a preview or a mail scanner does: plain GETs, following redirects,
  // more than once.
  for (let i = 0; i < 2; i++) {
    const response = await fetch(link, { redirect: "follow" });
    expect(response.status).toBe(200);
    expect(new URL(response.url).pathname).toBe("/auth/confirm");
  }
  await openAndSignIn(page, link);
  await expectSignedIn(page);
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
  await openAndSignIn(page, link);
  await expect(page).toHaveURL(/\/login\?error=link_expired/);
  await expect(alert(page)).toContainText("expired or was already used");
});

test("a used link explains itself", async ({ page, browser }) => {
  const link = await requestLink(page, uniqueEmail("used"));
  await openAndSignIn(page, link);
  await expectSignedIn(page);

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await openAndSignIn(second, link);
  await expect(second).toHaveURL(/\/login\?error=link_expired/);
  await expect(alert(second)).toContainText("expired or was already used");
  await secondContext.close();
});

test("a confirm page without its token says so and offers a new link", async ({
  page,
}) => {
  await page.goto("/auth/confirm");
  await expect(alert(page)).toContainText("This sign-in link is incomplete.");
  await expect(
    page.getByRole("link", { name: "Request a new one." }),
  ).toHaveAttribute("href", "/login");
});

test("another website cannot post a sign-in to this site", async ({
  request,
}) => {
  const response = await request.post("/auth/confirm/verify", {
    headers: { origin: "https://evil.example" },
    form: { token_hash: "pkce_anything", type: "email" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});
