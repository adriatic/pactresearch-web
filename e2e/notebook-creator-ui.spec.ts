import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 52: notebooks are created through the New Notebook modal now. The
// old flat form still exists in NotebookCreator but is hidden behind
// SHOW_LEGACY_NOTEBOOK_FORM, so these specs drive the modal instead.
async function createNotebookViaModal(page: Page, notebookName: string) {
  await page
    .locator("header")
    .getByRole("button", { name: "New Notebook" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name:").fill(notebookName);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(dialog).toBeHidden();
}

// Two manual-testing bugs fixed together: (1) creating a notebook or
// discussion used to dump the raw JSON API response into the UI instead of
// a human-readable confirmation; (2) every <button> in the app rendered as
// plain inline text, indistinguishable from static content, since none of
// them had any visual treatment at all.

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

async function signInFreshUser(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  emailPrefix: string,
) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${emailPrefix}-${suffix}@example.com`;
  const password = "correct horse battery staple 14!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
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
  return { suffix };
}

test.setTimeout(60_000);

// Retargeted (task 48). This used to assert a textual confirmation --
// `Notebook "X" created.` and its discussion equivalent. Those were
// deliberately removed afterwards; NotebookCreator.tsx says so in its own
// comment: "Success confirmations used to live here too ... but the
// notebook/discussion appearing in the Explorer tree is already the
// confirmation -- a second textual one said nothing the tree didn't."
//
// So the spec had drifted, not caught a bug: it was asserting the
// presence of text the app no longer has by design. The half that still
// matters -- that the raw API response never appears on screen, which is
// what this file exists for -- is unchanged and still asserted at every
// step. The Explorer-tree assertions, which were already here, now carry
// the "it was created" half, matching what the component treats as the
// confirmation.
test("creating a notebook and a discussion never shows the raw API response, and the Explorer tree is the confirmation", async ({
  page,
  context,
}) => {
  const { suffix } = await signInFreshUser(page, context, "e2e-creator-ui");

  const notebookName = `E2E creator-ui notebook ${suffix}`;
  const discussionName = `E2E creator-ui discussion ${suffix}`;

  // Anything shaped like the raw JSON response (a quoted field name
  // followed by a colon) must never appear anywhere on the page.
  const jsonShapedText = page.getByText(/"(id|created_at|user_id)"\s*:/);

  await createNotebookViaModal(page, notebookName);

  // The Explorer tree IS the confirmation -- the notebook appearing there
  // is how the app reports success.
  await expect(
    page.getByRole("treeitem", { name: notebookName }),
  ).toBeVisible();
  await expect(jsonShapedText).toHaveCount(0);

  // And no textual confirmation came back: asserted explicitly so a
  // future change reintroducing one is a deliberate decision rather than
  // something that silently drifts back in.
  await expect(page.getByText(/" created\./)).toHaveCount(0);

  await page.getByLabel("Name:").last().fill(discussionName);
  await page.getByRole("button", { name: "Create discussion" }).click();

  await expect(
    page.getByRole("treeitem", { name: discussionName }),
  ).toBeVisible();
  await expect(jsonShapedText).toHaveCount(0);
  await expect(page.getByText(/" created\./)).toHaveCount(0);
});

test("buttons render with real visual treatment, distinct from static text and from a disabled state", async ({
  page,
  context,
}) => {
  await signInFreshUser(page, context, "e2e-button-style");

  // An enabled button: a real <button> element with an actual border and
  // background — not plain inline text.
  //
  // Task 52 moved "Create notebook" into the New Notebook modal, so the
  // modal has to be open for it to exist. Retargeted rather than swapped
  // for some other button: this is still the same control the styling
  // fix was originally about.
  await page
    .locator("header")
    .getByRole("button", { name: "New Notebook" })
    .click();
  const newNotebookDialog = page.getByRole("dialog", { name: "New notebook" });
  // A name is required for Create to be ENABLED, and an enabled button is
  // what this assertion is about -- without one it is correctly disabled
  // and would report cursor: not-allowed.
  await newNotebookDialog.getByLabel("Name:").fill("styling check");
  const createNotebookButton = newNotebookDialog.getByRole("button", {
    name: "Create notebook",
  });
  await expect(createNotebookButton).toBeVisible();
  await expect(createNotebookButton).toBeEnabled();
  // border-style alone isn't a reliable signal here — Tailwind's Preflight
  // resets border-style to "solid" globally (with 0 width) so that adding
  // a width later doesn't also require setting a style; border-width is
  // the part that's actually zero on unstyled elements.
  await expect(createNotebookButton).toHaveCSS("border-width", "1px");
  const backgroundColor = await createNotebookButton.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(backgroundColor).not.toBe("transparent");
  await expect(createNotebookButton).toHaveCSS("cursor", "pointer");

  // A disabled button still looks like a button, but visibly distinct in
  // its disabled state.
  //
  // This used "New Notebook", which task 52 enabled -- it opens the
  // modal now. Run is the honest replacement: a fresh user has no
  // discussion selected, so it is genuinely disabled rather than
  // disabled-as-a-placeholder, which makes it a better subject for this
  // assertion than the placeholders ever were.
  // Close the modal without creating anything, so the header is reachable.
  await newNotebookDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(newNotebookDialog).toBeHidden();
  const disabledButton = page
    .locator("header")
    .getByRole("button", { name: "Run" });
  await expect(disabledButton).toBeVisible();
  await expect(disabledButton).toBeDisabled();
  await expect(disabledButton).toHaveCSS("border-width", "1px");
  await expect(disabledButton).toHaveCSS("cursor", "not-allowed");

  // Static text (a heading) must not pick up button styling — proves the
  // fix is scoped to real buttons, not a blanket visual change.
  // "Notebook creator" was that heading; it is hidden with the legacy
  // form as of task 52, so this uses the Explorer's own heading.
  const heading = page.getByRole("heading", { name: "Explorer" });
  await expect(heading).toHaveCSS("border-width", "0px");
});
