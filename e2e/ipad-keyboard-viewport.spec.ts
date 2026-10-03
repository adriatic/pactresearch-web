import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 75. On an iPad, tapping into the prompt box opened the on-screen
// keyboard and the page appeared to freeze: Nik's Report a Problem capture
// showed the whole document shifted up 159px, which is exactly the
// workspace's 758px height minus the 599px left visible above the
// keyboard. The workspace was a fixed 100vh with overflow: hidden, so it
// never shrank to the visible area, and once WebKit scrolled the document
// to make room there was nothing the user could drag to scroll it back.
//
// Runs only in the webkit-ipad project (playwright.config.ts): WebKit,
// iPad UA, touch, and a 1080x758 viewport -- the visible area of
// iPadOS Chrome on an iPad (gen 7) in landscape, as in the capture.
//
// What Playwright cannot do is raise a real software keyboard. iPadOS
// reports one through window.visualViewport, which shrinks and fires
// "resize" while the layout viewport (and 100vh / 100dvh) stay put, so
// the init script below lets a test set visualViewport.height and fire
// that event itself -- the same signal the app sees on the device. Nik's
// own check on a real iPad stays the final confirmation.

const VISIBLE_WITHOUT_KEYBOARD = 758;
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

// Override visualViewport.height on the instance, falling back to the
// real value whenever no keyboard is being simulated.
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

async function openNewDiscussion(
  page: Page,
  context: import("@playwright/test").BrowserContext,
  label: string,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-ipad-keyboard-${label}-${suffix}@example.com`;
  const password = "correct horse battery staple 75!";
  const notebookName = `E2E iPad notebook ${suffix}`;
  const discussionName = `E2E iPad discussion ${suffix}`;

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

  const { error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

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

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(notebookRow).toBeVisible();
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").tap();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.tap();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName);
}

test("with the keyboard open the workspace fits the visible area and the composer stays usable", async ({
  page,
  context,
}) => {
  await openNewDiscussion(page, context, "fit");

  const workspace = page.locator("[data-group]").first();
  const prompt = page.getByLabel("Prompt");

  expect((await workspace.boundingBox())!.height).toBe(
    VISIBLE_WITHOUT_KEYBOARD,
  );

  await prompt.tap();
  await setKeyboard(page, true);

  // The workspace shrinks to what is visible above the keyboard...
  await expect
    .poll(async () => (await workspace.boundingBox())!.height)
    .toBe(VISIBLE_WITH_KEYBOARD);

  // ...so nothing it holds sits under the keyboard or above the screen.
  const promptBox = (await prompt.boundingBox())!;
  expect(promptBox.y).toBeGreaterThanOrEqual(0);
  expect(promptBox.y + promptBox.height).toBeLessThanOrEqual(
    VISIBLE_WITH_KEYBOARD,
  );
  const transcriptPanel = page.locator("[data-panel]").last();
  const transcriptBox = (await transcriptPanel.boundingBox())!;
  expect(transcriptBox.y + transcriptBox.height).toBeLessThanOrEqual(
    VISIBLE_WITH_KEYBOARD,
  );

  // The composer still takes input while the keyboard is up.
  await page.keyboard.type("typed with the keyboard open");
  await expect(prompt).toContainText("typed with the keyboard open");

  // Keyboard dismissed: back to full height, and still editable.
  await setKeyboard(page, false);
  await expect
    .poll(async () => (await workspace.boundingBox())!.height)
    .toBe(VISIBLE_WITHOUT_KEYBOARD);
  await prompt.tap();
  await page.keyboard.type(" and after");
  await expect(prompt).toContainText("typed with the keyboard open and after");
});

test("a document left scrolled by the keyboard is put back when the keyboard closes", async ({
  page,
  context,
}) => {
  await openNewDiscussion(page, context, "stranded");

  const workspace = page.locator("[data-group]").first();
  const prompt = page.getByLabel("Prompt");
  await prompt.tap();
  await setKeyboard(page, true);

  // Rebuild the state in Nik's capture: WebKit scrolls the document by
  // the keyboard's height when it opens. Desktop WebKit will not scroll a
  // document that already fits, so a temporary spacer makes room for the
  // same 159px scroll first.
  const shift = VISIBLE_WITHOUT_KEYBOARD - VISIBLE_WITH_KEYBOARD;
  await page.evaluate((shift) => {
    const spacer = document.createElement("div");
    spacer.id = "e2e-scroll-spacer";
    spacer.style.height = "2000px";
    document.body.appendChild(spacer);
    window.scrollTo(0, shift);
  }, shift);

  // Without the fix this reproduces the capture's own numbers -- <body>
  // and the workspace both at y -159, and still there after the keyboard
  // closes. With it, WebKit's visualViewport "scroll" event can undo the
  // shift before the keyboard even closes, so only the end state is
  // asserted.

  // Keyboard closes. Nothing on screen can scroll the document back, so
  // the app has to. Checked with the spacer still in place: removing it
  // first would shrink the document and clamp the scroll to 0 on its own,
  // passing whether or not the app did anything.
  await setKeyboard(page, false);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() =>
    document.getElementById("e2e-scroll-spacer")!.remove(),
  );
  expect((await workspace.boundingBox())!.y).toBe(0);
  const promptBox = (await prompt.boundingBox())!;
  expect(promptBox.y).toBeGreaterThanOrEqual(0);
});
