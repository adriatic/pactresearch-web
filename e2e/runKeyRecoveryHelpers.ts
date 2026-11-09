import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { LlmProviderId } from "@/lib/llmProviders";
import type { StandIn } from "./refineHelpers";
import {
  openDiscussion,
  seedKeyUser,
  waitForFirstDiscussion,
  type KeyUser,
} from "./keyRecoveryHelpers";

// Task D17k. Shared by run-key-recovery.spec.ts (Chrome) and
// ipad-run-key-recovery.spec.ts: a discussion with several long answers,
// the Run's refused-key error above the composer, and "in view" checked
// by position. Replies come from the local stand-ins in refineHelpers.ts
// ("REJECT" in the prompt makes them answer 401). No real model is called.

export const ANSWERS = 6;
const PARAGRAPH =
  "This answer is long on purpose, so that the discussion is taller than the window and the newest answer's buttons sit far below the first answer. ";

/** The user of seedKeyUser, with ANSWERS long answers, at the discussion. */
export async function seedWithAnswers(
  page: Page,
  context: BrowserContext,
  opts: { tag: string; provider: LlmProviderId; stand: StandIn },
): Promise<KeyUser> {
  const seeded = await seedKeyUser(page, context, opts);
  for (let n = 1; n <= ANSWERS; n++) {
    const { error } = await seeded.admin.from("responses").insert({
      discussion_id: seeded.discussionId,
      user_id: seeded.userId,
      prompt_text: `Earlier prompt ${n}`,
      response: Array.from({ length: 8 }, () => PARAGRAPH).join("\n\n"),
      model: opts.provider === "anthropic" ? "claude-sonnet-5" : "gpt-5",
      resolved_model:
        opts.provider === "anthropic" ? "claude-sonnet-5" : "gpt-5",
      cell_type: "assistant",
      created_at: new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString(),
    });
    if (error) throw error;
  }
  // A fresh load shows the new answers. With two notebooks the app first
  // opens a discussion of its own choosing; wait for that, then open ours.
  await page.goto("/");
  await waitForFirstDiscussion(page);
  await openDiscussion(page, seeded.notebookName, seeded.discussionName);
  await expect(continueButtons(page)).toHaveCount(ANSWERS, { timeout: 15_000 });
  return seeded;
}

export const runBar = (page: Page) =>
  page.getByRole("group", { name: "Run error" });
export const runBarWords = (page: Page) => runBar(page).getByRole("alert");
export const prompt = (page: Page) => page.getByLabel("Prompt");
export const continueButtons = (page: Page) =>
  page.locator("main").getByRole("button", { name: "Continue", exact: true });
export const askButtons = (page: Page) =>
  page
    .locator("main")
    .getByRole("button", { name: "Ask about this answer only" });

/** Types into the composer (replacing what is there) and presses Run. */
export async function typeAndRun(page: Page, text: string) {
  await prompt(page).fill(text);
  await page.locator("header").getByRole("button", { name: "Run" }).click();
}

/** Scrolls the list of answers to its top or its end. */
export async function scrollAnswers(page: Page, to: "top" | "end") {
  await page.locator("main").evaluate((main, where) => {
    const scroller = main.parentElement!;
    scroller.scrollTop = where === "top" ? 0 : scroller.scrollHeight;
  }, to);
}

/** The list of answers is taller than its visible part (it scrolls). */
export async function expectAnswersScroll(page: Page) {
  const { scrollHeight, clientHeight } = await page
    .locator("main")
    .evaluate((main) => ({
      scrollHeight: main.parentElement!.scrollHeight,
      clientHeight: main.parentElement!.clientHeight,
    }));
  expect(scrollHeight).toBeGreaterThan(clientHeight * 2);
}

/**
 * In view by position: the element's box lies inside the window and
 * inside the visible part of the list of answers if it is in that list,
 * and the point at its centre is the element itself (nothing covers it).
 */
export async function expectInView(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  what: string,
) {
  const result = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    let left = 0;
    let right = window.innerWidth;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(style.overflowY)) {
        const r = p.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
      }
    }
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      box: {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
      },
      visible: { top, bottom, left, right },
      uncovered: !!hit && (hit === el || el.contains(hit)),
    };
  });
  expect(result.box.top, `${what}: top`).toBeGreaterThanOrEqual(
    result.visible.top - 1,
  );
  expect(result.box.bottom, `${what}: bottom`).toBeLessThanOrEqual(
    result.visible.bottom + 1,
  );
  expect(result.box.left, `${what}: left`).toBeGreaterThanOrEqual(
    result.visible.left - 1,
  );
  expect(result.box.right, `${what}: right`).toBeLessThanOrEqual(
    result.visible.right + 1,
  );
  expect(result.uncovered, `${what}: not covered`).toBe(true);
}

export const accountDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Account" });

export const KEY_LABEL = {
  anthropic: "Anthropic API key:",
  openai: "OpenAI API key:",
} as const;

/** In Account → Keys: saves `key` for `provider` and waits for the word. */
export async function saveKey(
  page: Page,
  provider: LlmProviderId,
  key: string,
) {
  const dialog = accountDialog(page);
  const scope =
    provider === "openai"
      ? dialog.getByRole("group", { name: "OpenAI key" })
      : dialog.getByRole("tabpanel", { name: "Keys" });
  if (provider === "openai") {
    const details = dialog.locator("details");
    if ((await details.getAttribute("open")) === null) {
      await dialog.getByText("ChatGPT (optional)").click();
    }
  }
  await scope.getByLabel(KEY_LABEL[provider]).fill(key);
  await scope.getByRole("button", { name: "Save" }).first().click();
  await expect(scope.getByText("API key saved.").first()).toBeVisible();
}
