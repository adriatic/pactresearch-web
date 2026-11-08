import { test, expect, type Page } from "@playwright/test";
import {
  openSettings,
  PROMPT,
  putConversation,
  seededConversation,
  seedRefineUser,
  startStandIn,
  type StandIn,
} from "./refineHelpers";

// Task D17e on Nik's iPad (the webkit-ipad project, 1080x758): Notebook
// settings, now a role="dialog", fits above the on-screen keyboard and
// scrolls inside; the Refine history scrolls inside its own box and is
// kept at the newest message; nothing scrolls sideways; the Refine
// buttons are at least 44 points tall. The keyboard is simulated through
// visualViewport, as in ipad-modal-height.spec.ts. Replies come from a
// local stand-in.

const VISIBLE_WITH_KEYBOARD = 599;

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

let claude: StandIn;

test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  claude = await startStandIn("anthropic", 54710 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
});

test("Notebook settings with a long conversation fits above the keyboard, scrolls inside, and nothing scrolls sideways", async ({
  page,
  context,
}) => {
  await page.addInitScript(installKeyboardSimulation);
  const seeded = await seedRefineUser(page, context, {
    tag: "ipad-refine",
    provider: "anthropic",
    key: claude.key,
  });
  // 12 messages with long replies, the last asking a question: taller
  // than the history box, and a long unbroken word in one of them.
  await putConversation(
    page,
    seeded.notebookId,
    seededConversation(12, "anthropic", (i) =>
      i === 3
        ? "w".repeat(600)
        : `Reply ${i}. ${"A longer answer that wraps over several lines. ".repeat(6)}`,
    ),
  );

  const dialog = await openSettings(page);
  const input = dialog.getByRole("textbox", { name: "Refine with AI" });
  const history = dialog.getByRole("log", {
    name: "Refine with AI conversation",
  });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(12);

  await input.tap();
  await setKeyboard(page, true);

  // The whole dialog sits inside what is visible above the keyboard.
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return box.y >= 0 && box.y + box.height <= VISIBLE_WITH_KEYBOARD;
    })
    .toBe(true);

  // The history scrolls inside itself, kept at the newest message.
  expect(
    await history.evaluate((el) => ({
      scrolls: el.scrollHeight > el.clientHeight,
      atNewest: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2,
    })),
  ).toEqual({ scrolls: true, atNewest: true });

  // Nothing scrolls sideways: not the history, the dialog or the page.
  for (const [what, width] of [
    [
      "history",
      await history.evaluate((el) => el.scrollWidth - el.clientWidth),
    ],
    ["dialog", await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)],
    [
      "page",
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ],
  ] as const) {
    expect(width, what).toBeLessThanOrEqual(0);
  }

  // A turn with the keyboard up: the reply arrives, the history follows
  // it, and the marked prompt can be used.
  await input.fill("A field ecologist, cautious.");
  await dialog.getByRole("button", { name: "Send", exact: true }).tap();
  await expect(dialog.locator("[data-refine-prompt]")).toHaveText(
    PROMPT.anthropic,
    { timeout: 15_000 },
  );
  await expect
    .poll(() =>
      history.evaluate(
        (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2,
      ),
    )
    .toBe(true);

  // Touch targets: the Refine buttons are at least 44 points tall.
  const use = dialog.getByRole("button", { name: "Use this prompt" });
  for (const button of [
    dialog.getByRole("button", { name: "Send", exact: true }),
    use,
    dialog.getByRole("button", { name: "Start over", exact: true }),
  ]) {
    await button.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  await use.tap();
  await expect(dialog.getByLabel("System prompt:")).toHaveValue(
    PROMPT.anthropic,
  );

  // Save, the last thing in the dialog, can be scrolled to and lies in
  // the visible area above the keyboard.
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await save.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const saveBox = (await save.boundingBox())!;
  expect(saveBox.y).toBeGreaterThanOrEqual(0);
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(VISIBLE_WITH_KEYBOARD);
  await save.tap();
  await expect(dialog).toHaveCount(0);
});
