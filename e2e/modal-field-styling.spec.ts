import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Every text-entry field in every modal must have a visible resting
// border and inner padding around its value.
//
// The bug this pins: Tailwind's preflight zeroes padding and border on
// every element (`*, ::before, ::after { padding: 0; border: 0 solid }`
// in node_modules/tailwindcss/preflight.css), so a plain <input> or
// <textarea> renders with no boundary at all until it is focused and
// the browser paints its own focus ring -- and its value sits flush
// against the edge. The same reset is what made every <button> render
// as unstyled inline text, which globals.css already fixes with a
// blanket `button {}` rule; this is that same fix for text entry.
//
// Asserted from the computed style rather than a screenshot: pixel
// comparison would fail on every unrelated copy change, and what
// actually matters here is a real border box with real padding, not an
// exact rendering. The cross-modal check at the end is the other half
// of the task -- the fields must not merely each have *a* border, they
// must all have the SAME one, which is the property that decays as
// dialogs get added one at a time.

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

test.setTimeout(90_000);

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-field-styling-${suffix}@example.com`;
  const password = "correct horse battery staple 56!";
  const notebookName = `E2E field-styling notebook ${suffix}`;
  const discussionName = `E2E field-styling discussion ${suffix}`;

  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw userErr ?? new Error("no user");
  const userId = created.user.id;

  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
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
  const { error: signInError } = await jarClient.auth.signInWithPassword({
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

  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
  // Settings is only enabled once the discussion's own load resolves.
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
}

interface FieldMetrics {
  label: string;
  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderStyle: string;
  borderColor: string;
  borderRadius: string;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
}

// Every text-entry control inside a given dialog. Radio, checkbox, file
// and the like are deliberately excluded: they are widgets with their
// own shape, and a text-field border box around one looks wrong.
const TEXT_FIELD_SELECTOR =
  'input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="range"]):not([type="color"]), textarea';

async function fieldsIn(container: Locator): Promise<FieldMetrics[]> {
  const fields = container.locator(TEXT_FIELD_SELECTOR);
  const count = await fields.count();
  expect(
    count,
    "the dialog must actually have fields to check",
  ).toBeGreaterThan(0);

  const metrics: FieldMetrics[] = [];
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    metrics.push(
      await field.evaluate((el) => {
        const s = getComputedStyle(el);
        const input = el as HTMLInputElement;
        return {
          label:
            input.getAttribute("aria-label") ||
            input.placeholder ||
            `${el.tagName.toLowerCase()}[${input.type ?? ""}]`,
          borderTopWidth: parseFloat(s.borderTopWidth),
          borderRightWidth: parseFloat(s.borderRightWidth),
          borderBottomWidth: parseFloat(s.borderBottomWidth),
          borderLeftWidth: parseFloat(s.borderLeftWidth),
          borderStyle: s.borderTopStyle,
          borderColor: s.borderTopColor,
          borderRadius: s.borderTopLeftRadius,
          paddingTop: parseFloat(s.paddingTop),
          paddingRight: parseFloat(s.paddingRight),
          paddingBottom: parseFloat(s.paddingBottom),
          paddingLeft: parseFloat(s.paddingLeft),
        };
      }),
    );
  }
  return metrics;
}

function assertWellDressed(where: string, metrics: FieldMetrics[]) {
  for (const m of metrics) {
    const at = `${where} → ${m.label}`;
    // A real border on all four sides, at rest -- not only on focus.
    expect(m.borderStyle, `${at}: border style`).toBe("solid");
    expect(m.borderTopWidth, `${at}: border-top`).toBeGreaterThanOrEqual(1);
    expect(m.borderRightWidth, `${at}: border-right`).toBeGreaterThanOrEqual(1);
    expect(m.borderBottomWidth, `${at}: border-bottom`).toBeGreaterThanOrEqual(
      1,
    );
    expect(m.borderLeftWidth, `${at}: border-left`).toBeGreaterThanOrEqual(1);
    // Breathing room around the value, horizontally and vertically.
    expect(m.paddingLeft, `${at}: padding-left`).toBeGreaterThanOrEqual(4);
    expect(m.paddingRight, `${at}: padding-right`).toBeGreaterThanOrEqual(4);
    expect(m.paddingTop, `${at}: padding-top`).toBeGreaterThanOrEqual(4);
    expect(m.paddingBottom, `${at}: padding-bottom`).toBeGreaterThanOrEqual(4);
  }
}

function signature(m: FieldMetrics) {
  return [
    m.borderTopWidth,
    m.borderStyle,
    m.borderColor,
    m.borderRadius,
    m.paddingTop,
    m.paddingRight,
    m.paddingBottom,
    m.paddingLeft,
  ].join("|");
}

test("every modal's text fields have a resting border and inner padding, and all modals match", async ({
  page,
  context,
}, testInfo) => {
  await seed(page, context);

  const header = page.locator("header");
  const everyField: { where: string; metrics: FieldMetrics[] }[] = [];

  async function capture(where: string, dialog: Locator) {
    await expect(dialog).toBeVisible();
    const metrics = await fieldsIn(dialog);
    assertWellDressed(where, metrics);
    everyField.push({ where, metrics });
    // Attached for the visual pass the task asks for -- never
    // compared against a baseline, which would fail on every unrelated
    // copy change. MODAL_SHOTS_DIR additionally drops them somewhere
    // stable to actually look at them while working on the styling.
    const shot = await dialog.screenshot();
    await testInfo.attach(`${where}.png`, {
      body: shot,
      contentType: "image/png",
    });
    const shotsDir = process.env.MODAL_SHOTS_DIR;
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      writeFileSync(join(shotsDir, `${where.replace(/\W+/g, "-")}.png`), shot);
    }
  }

  // 1. Account → Profile (name, email, use case).
  await header.getByRole("button", { name: "Account" }).click();
  const account = page.getByRole("dialog", { name: "Account" });
  await capture("Account (Profile)", account);

  // 2. Account → Keys (the API key field).
  await account.getByRole("tab", { name: "Keys" }).click();
  await expect(account.getByLabel("Anthropic API key:")).toBeVisible();
  await capture("Account (Keys)", account);
  await account.getByRole("button", { name: "Close" }).click();

  // 3. Notebook settings (Refine with AI, system prompt).
  await header.getByRole("button", { name: "Settings" }).click();
  // This dialog has no role="dialog" of its own, so it is located by the
  // section its heading sits in.
  const settings = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Notebook settings" }) });
  await capture("Notebook settings", settings);
  await settings.getByRole("button", { name: "Cancel" }).click();

  // 4. New notebook (name, research question, the disabled Refine field).
  await header.getByRole("button", { name: "New Notebook" }).click();
  const newNotebook = page.getByRole("dialog", { name: "New notebook" });
  await capture("New notebook", newNotebook);
  await newNotebook.getByRole("button", { name: "Cancel" }).click();

  // The dialogs must agree with each other, not merely each be styled.
  // A field that drifts shows up here as its own signature.
  const signatures = new Map<string, string[]>();
  for (const { where, metrics } of everyField) {
    for (const m of metrics) {
      const key = signature(m);
      signatures.set(key, [
        ...(signatures.get(key) ?? []),
        `${where} → ${m.label}`,
      ]);
    }
  }
  expect(
    [...signatures.keys()].length,
    `field treatments differ between modals: ${JSON.stringify(
      Object.fromEntries(signatures),
      null,
      2,
    )}`,
  ).toBe(1);
});
