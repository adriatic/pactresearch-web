import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";
import type { LlmProviderId } from "@/lib/llmProviders";
import {
  openSeededDiscussion,
  seedSignedIn,
  type Seeded,
} from "./themeHelpers";
import { contrastSweep, MIN_CONTRAST } from "./themeHelpers";
import { openSettings, settingsDialog, type StandIn } from "./refineHelpers";

// Task D17i. Shared by key-recovery.spec.ts (Chrome) and
// ipad-key-recovery.spec.ts (the iPad project): the refused-key words,
// a user with a second notebook, signing back in after a sign-out, and
// the layout and contrast checks for the longer words. Replies come from
// the local stand-ins in refineHelpers.ts ("REJECT" in a message makes
// them answer 401). No real model is called.

export const REJECTED = {
  anthropic:
    "Anthropic rejected your API key. It may have been deleted, disabled or expired in the Anthropic console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys.",
  // A Run and Refine both add OpenAI's reason after the sentence.
  openai:
    "OpenAI rejected your API key. It may have been deleted, disabled or expired in the OpenAI console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys. (OpenAI: invalid_api_key)",
} as const;

export const parts = (dialog: Locator) => ({
  input: dialog.getByRole("textbox", { name: "Refine with AI" }),
  send: dialog.getByRole("button", { name: "Send", exact: true }),
  history: dialog.getByRole("log", { name: "Refine with AI conversation" }),
  alert: dialog.getByRole("alert"),
  startOver: dialog.getByRole("button", { name: "Start over", exact: true }),
  field: dialog.getByLabel("System prompt:"),
  cancel: dialog.getByRole("button", { name: "Cancel" }),
});

export const runError = (page: Page) => page.locator("main").getByRole("alert");

export interface KeyUser extends Seeded {
  other: { notebookName: string; discussionName: string };
}

/**
 * A signed-in user on `provider` with the stand-in's key saved, a second
 * notebook (with one discussion), at the first notebook's discussion.
 */
export async function seedKeyUser(
  page: Page,
  context: BrowserContext,
  opts: { tag: string; provider: LlmProviderId; stand: StandIn },
): Promise<KeyUser> {
  const seeded = await seedSignedIn(context, { tag: opts.tag });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const other = {
    notebookName: `E2E ${opts.tag} second notebook ${suffix}`,
    discussionName: `E2E ${opts.tag} second discussion ${suffix}`,
  };
  const { data: notebook, error } = await seeded.admin
    .from("notebooks")
    .insert({ user_id: seeded.userId, name: other.notebookName })
    .select()
    .single();
  if (error) throw error;
  const { error: discussionError } = await seeded.admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: seeded.userId,
      name: other.discussionName,
      total_time_ms: 0,
    });
  if (discussionError) throw discussionError;
  if (opts.provider === "openai") {
    const { error: metaError } = await seeded.admin.auth.admin.updateUserById(
      seeded.userId,
      { user_metadata: { llm_provider: "openai" } },
    );
    if (metaError) throw metaError;
  }
  const route =
    opts.provider === "anthropic"
      ? "/api/account/anthropic-key"
      : "/api/account/openai-key";
  const saved = await page.request.post(route, {
    data: { key: opts.stand.key },
  });
  expect(saved.ok()).toBe(true);
  await openSeededDiscussion(page, seeded);
  await expect(
    page.locator("header").getByRole("combobox", { name: "Provider" }),
  ).toHaveValue(opts.provider);
  return { ...seeded, other };
}

/** Opens a discussion from the tree without reloading the page. */
export async function openDiscussion(
  page: Page,
  notebookName: string,
  discussionName: string,
) {
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.locator("h3").click();
  }
  await page
    .getByRole("treeitem", { name: discussionName, exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
}

/**
 * Sends `text` in Refine with AI and waits for the refusal. Returns the
 * route's answer as text, to check that no part of the key is in it.
 */
export async function refuseInRefine(
  page: Page,
  dialog: Locator,
  text: string,
  provider: LlmProviderId,
): Promise<string> {
  const p = parts(dialog);
  await expect(p.input).toBeEnabled();
  await p.input.fill(text);
  // Enter does nothing while the dialog still loads its System prompt
  // (D17e2): wait until Send can be pressed.
  await expect(p.send).toBeEnabled();
  const answer = page.waitForResponse(
    (r) =>
      r.url().includes("/api/refine-conversation") &&
      r.request().method() === "POST",
  );
  await p.input.press("Enter");
  const response = await answer;
  expect(response.status()).toBe(400);
  await expect(p.alert).toHaveText(REJECTED[provider]);
  await expect(p.input).toHaveValue(text);
  return response.text();
}

/** Cancel, then open Notebook settings again; returns the new dialog. */
export async function closeAndReopen(page: Page) {
  await parts(settingsDialog(page)).cancel.click();
  await expect(settingsDialog(page)).toHaveCount(0);
  const dialog = await openSettings(page);
  // The conversation has loaded once the input can be typed into.
  await expect(parts(dialog).input).toBeEnabled();
  return dialog;
}

/** No part of the stand-in key in the page (text or HTML) or `answer`. */
export async function expectNoKey(page: Page, stand: StandIn, answer: string) {
  const html = await page.content();
  const shown = await page.evaluate(() => document.body.innerText);
  for (const where of [html, shown]) {
    expect(where).not.toContain(stand.key);
    expect(where).not.toMatch(/sk-ant-|sk-e2e-|e2e-mock/);
  }
  expect(answer).not.toContain(stand.key);
  expect(answer).not.toMatch(/sk-|mock/);
  // The last four characters (Account → Keys' hint) are not in the words.
  expect(answer).not.toContain(stand.key.slice(-4));
}

/** Signs the same user in again after a sign-out (a fresh session). */
export async function signBackIn(context: BrowserContext, seeded: Seeded) {
  const { API_URL, ANON_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
  const { data } = await seeded.admin.auth.admin.getUserById(seeded.userId);
  const email = data.user!.email!;
  const password = "key recovery e2e D17i!";
  const { error } = await seeded.admin.auth.admin.updateUserById(
    seeded.userId,
    { password },
  );
  if (error) throw error;
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
}

/** Nothing scrolls sideways: the element itself, `container`, the page. */
export async function expectNoSidewaysScroll(
  page: Page,
  element: Locator,
  container: Locator,
) {
  const over = async (l: Locator) =>
    l.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await over(element), "the words").toBeLessThanOrEqual(0);
  expect(await over(container), "their container").toBeLessThanOrEqual(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
    "the page",
  ).toBeLessThanOrEqual(0);
  // And the words sit inside the window's width.
  const box = (await element.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

/** The words, measured as drawn, reach 4.5:1. */
export async function expectReadable(scope: Locator, words: string) {
  const items = await contrastSweep(scope);
  const mine = items.filter((i) => i.text.includes(words.slice(0, 40)));
  expect(mine.length, `"${words.slice(0, 40)}…" measured`).toBeGreaterThan(0);
  for (const i of mine) {
    expect(
      i.ratio,
      `"${i.text.slice(0, 40)}…" ${i.fg} on ${i.bg}`,
    ).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }
}
