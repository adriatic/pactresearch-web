import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  openSettings,
  putConversation,
  seededConversation,
  seedRefineUser,
  settingsDialog,
  startStandIn,
  type StandIn,
} from "./refineHelpers";

// Task D17e2. Nik's Preview trial (2026-11-07): after a conversation of
// 10 messages whose fourth reply closes its prompt with the start marker
// a second time (no end marker; unfinished at D17e2, read as complete
// since D17g), a closing message and Claude's closing
// reply, the Refine input took a character; after Cancel and reopening
// Notebook settings it could not be typed into. Replies come from a local
// stand-in; no real model is called.

let claude: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  claude = await startStandIn("anthropic", 54740 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
});

// The fourth reply (index 7) as in Nik's trial: a prompt begun with the
// start marker, the start marker again where the end marker belongs.
const TWO_STARTS =
  "Thank you, that is everything I need. Here is the system prompt:\n\n" +
  "SYSTEM_PROMPT_START\n" +
  "You are assisting a researcher who studies **coral reefs**.\n\n" +
  "Be cautious and cite sources.\n" +
  "SYSTEM_PROMPT_START\n\n" +
  "Would you like to refine it further?";

const longReply = (i: number) =>
  `Reply ${i}. A **bold** word.\n\n` +
  "A longer paragraph that wraps over several lines. ".repeat(8) +
  "\n\nWhat is your role in this research?";

const NIK_CONVERSATION = () =>
  seededConversation(10, "anthropic", (i) =>
    i === 7 ? TWO_STARTS : longReply(i),
  );

async function expectTypable(
  page: Page,
  input: Locator,
  text: string,
  // Task D17i: after reopening, the unsent text is kept, so what is typed
  // goes after it.
  kept = "",
) {
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(kept);
  await input.click();
  await input.press("End");
  await page.keyboard.type(text);
  await expect(input).toHaveValue(kept + text);
}

test("after a 10-message conversation whose prompt was closed with the start marker twice, the input takes text when the dialog is opened and again after Cancel and reopening", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-reopen",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, NIK_CONVERSATION());

  let dialog = await openSettings(page);
  let input = dialog.getByRole("textbox", { name: "Refine with AI" });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await expectTypable(page, input, "x");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);

  dialog = await openSettings(page);
  input = dialog.getByRole("textbox", { name: "Refine with AI" });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await expectTypable(page, input, "y", "x");
});

test("after the closing message and a closing reply without a question, the input takes text again after Cancel and reopening", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-reopen-closing",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, NIK_CONVERSATION());

  let dialog = await openSettings(page);
  let input = dialog.getByRole("textbox", { name: "Refine with AI" });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await input.fill("no need to refine this further CLOSING");
  await input.press("Enter");
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(12, {
    timeout: 15_000,
  });
  await expectTypable(page, input, "z");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);

  dialog = await openSettings(page);
  input = dialog.getByRole("textbox", { name: "Refine with AI" });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(12);
  await expectTypable(page, input, "w", "z");
});

// A route held until the test lets it go, so the window in which the
// dialog is still loading can be looked at without guessing a delay.
async function holdGet(page: Page, pattern: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  return release;
}

test("while Notebook settings is still loading its System prompt, the Refine input takes text; Send waits for it", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-reopen-settings-load",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, NIK_CONVERSATION());

  // Opened once and closed, then reopened with the settings' own GET held.
  let dialog = await openSettings(page);
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);

  const release = await holdGet(page, "**/api/notebooks?id=*");
  dialog = await openSettings(page);
  const input = dialog.getByRole("textbox", { name: "Refine with AI" });
  const send = dialog.getByRole("button", { name: "Send", exact: true });
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await expect(dialog.getByLabel("System prompt:")).toBeDisabled();
  await expectTypable(page, input, "typed while loading");
  await expect(send).toBeDisabled();

  release();
  await expect(dialog.getByLabel("System prompt:")).toBeEnabled();
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue("typed while loading");
});

test("while the conversation is loading, the dialog says so in words; then the input takes text", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-reopen-conv-load",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, NIK_CONVERSATION());

  const release = await holdGet(
    page,
    "**/api/refine-conversation?notebookId=*",
  );
  const dialog = await openSettings(page);
  const input = dialog.getByRole("textbox", { name: "Refine with AI" });
  // Closed until the stored conversation is known (or a send would
  // overwrite it), and the reason is on the screen.
  await expect(
    dialog.getByRole("status").filter({ hasText: "Loading the conversation…" }),
  ).toBeVisible();
  await expect(input).toBeDisabled();

  release();
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await expect(dialog.getByText("Loading the conversation…")).toHaveCount(0);
  await expectTypable(page, input, "after loading");
});

test("a stored conversation that fails the check is not shown silently: the dialog says so, and the input takes text", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-reopen-unreadable",
    provider: "anthropic",
    key: claude.key,
  });
  // Two user messages in a row: refused by checkStoredConversation. Only
  // the local database is written, with the local Docker key.
  const { error } = await seeded.admin.from("refine_conversations").upsert({
    notebook_id: seeded.notebookId,
    user_id: seeded.userId,
    messages: [
      { role: "user", content: "One." },
      { role: "user", content: "Two." },
    ],
  });
  if (error) throw error;

  const dialog = await openSettings(page);
  await expect(
    dialog.getByRole("alert").filter({
      hasText:
        "The saved conversation for this notebook could not be read, so it is not shown. Your next message starts a new conversation.",
    }),
  ).toBeVisible();
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(0);
  await expectTypable(
    page,
    dialog.getByRole("textbox", { name: "Refine with AI" }),
    "a",
  );
});
