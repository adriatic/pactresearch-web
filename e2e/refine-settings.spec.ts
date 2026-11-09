import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  getConversation,
  markedReply,
  openSettings,
  PROMPT,
  putConversation,
  QUESTION,
  savedSystemPrompt,
  seededConversation,
  seedRefineUser,
  settingsDialog,
  startStandIn,
  UNFINISHED_REPLY,
  type StandIn,
} from "./refineHelpers";
import { contrastSweep, MIN_CONTRAST } from "./themeHelpers";

// Task D17e. Refine with AI as a conversation in Notebook settings: the
// account's own service asks, then writes a marked prompt; "Use this
// prompt" fills the System prompt field, Save keeps it, and the
// conversation is kept per notebook on the server. Every reply comes from
// a local stand-in (refineHelpers.ts); no real model is called.

let claude: StandIn;
let chatgpt: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  // Ports of their own, clear of the other specs' stand-ins.
  claude = await startStandIn("anthropic", 54650 + workerInfo.workerIndex);
  chatgpt = await startStandIn("openai", 54680 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
  await chatgpt?.close();
});

const parts = (dialog: Locator) => ({
  input: dialog.getByRole("textbox", { name: "Refine with AI" }),
  send: dialog.getByRole("button", { name: "Send", exact: true }),
  history: dialog.getByRole("log", { name: "Refine with AI conversation" }),
  use: dialog.getByRole("button", { name: "Use this prompt" }),
  startOver: dialog.getByRole("button", { name: "Start over", exact: true }),
  keepIt: dialog.getByRole("button", { name: "Keep it" }),
  field: dialog.getByLabel("System prompt:"),
  save: dialog.getByRole("button", { name: "Save", exact: true }),
  cancel: dialog.getByRole("button", { name: "Cancel" }),
  labels: dialog.locator("[data-refine-label]"),
  promptBox: dialog.locator("[data-refine-prompt]"),
});

async function sendWithEnter(page: Page, input: Locator, text: string) {
  await input.fill(text);
  await input.press("Enter");
}

test("Claude account: empty state, question, answer, marked prompt, Use this prompt, Save, reopen, Cancel", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-claude",
    provider: "anthropic",
    key: claude.key,
  });
  const claudeBefore = claude.calls();
  const chatgptBefore = chatgpt.calls();

  const dialog = await openSettings(page);
  const p = parts(dialog);

  // Empty: the label, the explanation and the input only.
  await expect(
    dialog.getByText("Refine with AI", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Answer a few questions and Claude will write a system prompt for this notebook.",
    ),
  ).toBeVisible();
  await expect(p.history).toHaveCount(0);
  await expect(p.use).toHaveCount(0);
  await expect(p.startOver).toHaveCount(0);
  await expect(p.input).toHaveAttribute(
    "placeholder",
    "Describe your research domain…",
  );
  await expect(p.input).toBeEnabled();
  await expect(p.send).toBeDisabled();
  await expect(p.send).toHaveText("→");

  // Shift+Enter is a new line, not a send.
  await p.input.fill("Coral reefs");
  await p.input.press("Shift+Enter");
  await p.input.pressSequentially("and their decline");
  await expect(p.input).toHaveValue("Coral reefs\nand their decline");
  await expect(p.history).toHaveCount(0);
  await expect(p.send).toBeEnabled();

  // Enter sends: the message shows at once, Claude is writing, the input
  // and Send wait, Save and Cancel do not.
  await p.input.press("Enter");
  await expect(p.history).toBeVisible();
  await expect(p.history).toContainText("Coral reefs\nand their decline");
  await expect(dialog.getByText("Claude is writing…")).toBeVisible();
  await expect(p.input).toBeDisabled();
  await expect(p.input).toHaveValue("");
  await expect(p.send).toBeDisabled();
  await expect(p.save).toBeEnabled();
  await expect(p.cancel).toBeEnabled();

  // The question, labelled Claude; the placeholder now asks for an answer.
  await expect(p.history).toContainText(QUESTION.anthropic);
  await expect(dialog.getByText("Claude is writing…")).toHaveCount(0);
  await expect(p.labels).toHaveText(["You", "Claude"]);
  await expect(p.input).toHaveAttribute("placeholder", "Answer the question…");
  await expect(p.use).toHaveCount(0);

  // The answer, sent with the arrow: a marked prompt, in its own box.
  await p.input.fill("A field ecologist, cautious, with sources.");
  await p.send.click();
  await expect(p.promptBox).toHaveText(PROMPT.anthropic);
  await expect(p.labels).toHaveText(["You", "Claude", "You", "Claude"]);
  // The text around the prompt is shown; the marker lines are not.
  await expect(p.history).toContainText("Would you like to refine it further?");
  await expect(p.history).not.toContainText("SYSTEM_PROMPT_START");
  await expect(p.use).toBeVisible();

  // Only Claude's stand-in was called, once per turn.
  expect(claude.calls() - claudeBefore).toBe(2);
  expect(chatgpt.calls() - chatgptBefore).toBe(0);

  // Kept to the newest message.
  const atBottom = () =>
    p.history.evaluate(
      (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2,
    );
  expect(await atBottom()).toBe(true);

  // Use this prompt replaces the field at once; nothing is saved yet.
  await p.field.fill("My own older text.");
  await p.use.click();
  await expect(p.field).toHaveValue(PROMPT.anthropic);
  await expect(
    dialog.getByText("Copied into the System prompt field. Save to keep it."),
  ).toBeVisible();
  expect(await savedSystemPrompt(page, seeded.notebookId)).toBeNull();

  // Save stores the field, read back through the API.
  await p.save.click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect
    .poll(() => savedSystemPrompt(page, seeded.notebookId))
    .toBe(PROMPT.anthropic);

  // The conversation is on the server, and reopening shows it.
  const stored = await getConversation(page, seeded.notebookId);
  expect(stored.map((m) => [m.role, m.provider ?? null])).toEqual([
    ["user", null],
    ["assistant", "anthropic"],
    ["user", null],
    ["assistant", "anthropic"],
  ]);
  expect(stored[3].content).toBe(markedReply("anthropic"));
  await openSettings(page);
  await expect(p.labels).toHaveText(["You", "Claude", "You", "Claude"]);
  await expect(p.promptBox).toHaveText(PROMPT.anthropic);
  await expect(p.field).toHaveValue(PROMPT.anthropic);
  await expect(p.input).toHaveAttribute("placeholder", "Answer the question…");
  // The copied line belonged to the last opening.
  await expect(
    dialog.getByText("Copied into the System prompt field. Save to keep it."),
  ).toHaveCount(0);

  // Cancel discards the field, not the conversation.
  await p.field.fill("An edit that is never saved.");
  await p.cancel.click();
  await expect(settingsDialog(page)).toHaveCount(0);
  expect(await savedSystemPrompt(page, seeded.notebookId)).toBe(
    PROMPT.anthropic,
  );
  await openSettings(page);
  await expect(p.field).toHaveValue(PROMPT.anthropic);
  await expect(p.labels).toHaveText(["You", "Claude", "You", "Claude"]);
  expect(await getConversation(page, seeded.notebookId)).toHaveLength(4);
});

test("ChatGPT account: the words and labels say ChatGPT, and only ChatGPT's stand-in is called", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-chatgpt",
    provider: "openai",
    key: chatgpt.key,
  });
  const claudeBefore = claude.calls();
  const chatgptBefore = chatgpt.calls();

  const dialog = await openSettings(page);
  const p = parts(dialog);
  await expect(
    dialog.getByText(
      "Answer a few questions and ChatGPT will write a system prompt for this notebook.",
    ),
  ).toBeVisible();

  await sendWithEnter(page, p.input, "Medieval trade routes");
  await expect(dialog.getByText("ChatGPT is writing…")).toBeVisible();
  await expect(p.history).toContainText(QUESTION.openai);
  await p.input.fill("A historian, critical.");
  await p.input.press("Enter");
  await expect(p.promptBox).toHaveText(PROMPT.openai);
  await expect(p.labels).toHaveText(["You", "ChatGPT", "You", "ChatGPT"]);

  expect(chatgpt.calls() - chatgptBefore).toBe(2);
  expect(claude.calls() - claudeBefore).toBe(0);

  await p.use.click();
  await expect(p.field).toHaveValue(PROMPT.openai);
  await p.save.click();
  await expect
    .poll(() => savedSystemPrompt(page, seeded.notebookId))
    .toBe(PROMPT.openai);
  const stored = await getConversation(page, seeded.notebookId);
  expect(
    stored.filter((m) => m.role === "assistant").map((m) => m.provider),
  ).toEqual(["openai", "openai"]);
});

test("an unfinished prompt shows the note, and no Use this prompt", async ({
  page,
  context,
}) => {
  await seedRefineUser(page, context, {
    tag: "refine-unfinished",
    provider: "anthropic",
    key: claude.key,
  });
  const dialog = await openSettings(page);
  const p = parts(dialog);
  await sendWithEnter(page, p.input, "UNFINISHED please");
  await expect(
    dialog.getByText(
      "This reply has an unfinished prompt (the end marker is missing). Ask for it again.",
    ),
  ).toBeVisible();
  // Shown as written, start marker included; nothing to copy.
  await expect(p.history).toContainText(UNFINISHED_REPLY.split("\n")[1]);
  await expect(p.promptBox).toHaveCount(0);
  await expect(p.use).toHaveCount(0);
});

for (const provider of ["anthropic", "openai"] as const) {
  const name = provider === "anthropic" ? "Claude" : "ChatGPT";
  test(`errors on a ${name} account: no key, then a rejected key, each with its words; the text goes back`, async ({
    page,
    context,
  }) => {
    const seeded = await seedRefineUser(page, context, {
      tag: `refine-errors-${provider}`,
      provider,
    });
    const dialog = await openSettings(page);
    const p = parts(dialog);

    // No key: nothing is sent.
    await sendWithEnter(page, p.input, "My domain, no key yet");
    await expect(dialog.getByRole("alert")).toHaveText(
      provider === "anthropic"
        ? "Refine with AI needs your Anthropic API key. Add it in Account → Keys, then try again. Nothing was sent."
        : "Refine with AI needs your OpenAI API key. Add it in Account → Keys, then try again. Nothing was sent.",
    );
    await expect(p.input).toHaveValue("My domain, no key yet");
    await expect(p.history).toHaveCount(0);
    await expect(p.input).toBeEnabled();

    // A key the service refuses.
    const stand = provider === "anthropic" ? claude : chatgpt;
    const route =
      provider === "anthropic"
        ? "/api/account/anthropic-key"
        : "/api/account/openai-key";
    expect(
      (await page.request.post(route, { data: { key: stand.key } })).ok(),
    ).toBe(true);
    await p.input.fill("REJECT this one");
    await p.send.click();
    await expect(dialog.getByRole("alert")).toHaveText(
      // Task D17i: the new words; ChatGPT with OpenAI's reason, as a Run.
      provider === "anthropic"
        ? "Anthropic rejected your API key. It may have been deleted, disabled or expired in the Anthropic console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys."
        : "OpenAI rejected your API key. It may have been deleted, disabled or expired in the OpenAI console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys. (OpenAI: invalid_api_key)",
    );
    await expect(p.input).toHaveValue("REJECT this one");
    await expect(p.history).toHaveCount(0);
    expect(await getConversation(page, seeded.notebookId)).toEqual([]);

    // The next good send clears the error.
    await p.input.fill("Fine now");
    await p.send.click();
    await expect(p.history).toContainText(QUESTION[provider]);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });
}

test("a reply that would make the conversation too long is shown, with the notice, and not stored", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-notice",
    provider: "anthropic",
    key: claude.key,
  });
  // 10 messages, 59,510 characters: one more turn fits, its reply does not.
  const seededMessages = seededConversation(10, "anthropic", (i) =>
    `${i}`.padEnd(11_900, "z"),
  );
  await putConversation(page, seeded.notebookId, seededMessages);

  const dialog = await openSettings(page);
  const p = parts(dialog);
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
  await sendWithEnter(page, p.input, "LONGREPLY please");
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(12);
  await expect(dialog.getByRole("alert")).toHaveText(
    "This conversation is too long to continue. Use the prompt you have, or start over.",
  );
  expect(await getConversation(page, seeded.notebookId)).toHaveLength(10);

  // Reopened, the reply is gone, as the notice said.
  await p.cancel.click();
  await openSettings(page);
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(10);
});

test("at 40 messages the input is closed, with the limit words; the prompt can still be used", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-limit",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(
    page,
    seeded.notebookId,
    seededConversation(40, "anthropic", (i) =>
      i === 39 ? markedReply("anthropic") : `Question ${i}?`,
    ),
  );
  const dialog = await openSettings(page);
  const p = parts(dialog);
  await expect(dialog.locator("[data-refine-message]")).toHaveCount(40);
  await expect(
    dialog.getByText(
      "This conversation is at its limit of 40 messages. Use the prompt you have, or start over.",
    ),
  ).toBeVisible();
  await expect(p.input).toBeDisabled();
  await expect(p.send).toBeDisabled();
  await p.use.click();
  await expect(p.field).toHaveValue(PROMPT.anthropic);
  await expect(p.startOver).toBeVisible();
});

test("Start over: Keep it keeps the conversation; Start over deletes it", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-start-over",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, [
    { role: "user", content: "Coral reefs" },
    { role: "assistant", content: QUESTION.anthropic, provider: "anthropic" },
  ]);
  const dialog = await openSettings(page);
  const p = parts(dialog);
  await expect(p.labels).toHaveText(["You", "Claude"]);

  const question = dialog.getByText(
    "Start a new conversation? The current one will be deleted.",
  );
  await p.startOver.click();
  await expect(question).toBeVisible();
  await p.keepIt.click();
  await expect(question).toHaveCount(0);
  await expect(p.labels).toHaveText(["You", "Claude"]);
  expect(await getConversation(page, seeded.notebookId)).toHaveLength(2);

  await p.startOver.click();
  await expect(question).toBeVisible();
  await p.startOver.click();
  await expect(question).toHaveCount(0);
  await expect(p.history).toHaveCount(0);
  await expect(p.startOver).toHaveCount(0);
  await expect(p.input).toHaveAttribute(
    "placeholder",
    "Describe your research domain…",
  );
  expect(await getConversation(page, seeded.notebookId)).toEqual([]);

  // And it stays deleted after reopening.
  await p.cancel.click();
  await openSettings(page);
  await expect(p.history).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`contrast on a ${scheme} device: history, prompt box, status, error and notes reach ${MIN_CONTRAST}:1`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const seeded = await seedRefineUser(page, context, {
      tag: `refine-contrast-${scheme}`,
      provider: "anthropic",
      key: claude.key,
    });
    await putConversation(page, seeded.notebookId, [
      { role: "user", content: "Coral reefs" },
      { role: "assistant", content: QUESTION.anthropic, provider: "anthropic" },
      { role: "user", content: "A field ecologist" },
      {
        role: "assistant",
        content: markedReply("anthropic"),
        provider: "anthropic",
      },
    ]);
    const dialog = await openSettings(page);
    const p = parts(dialog);
    await expect(p.promptBox).toBeVisible();

    const failures: string[] = [];
    const sweep = async (state: string, mustSee: string[]) => {
      const items = await contrastSweep(dialog);
      for (const text of mustSee) {
        expect(
          items.some((i) => i.text.includes(text)),
          `${state}: "${text}" measured`,
        ).toBe(true);
      }
      for (const i of items) {
        // Light only: Tailwind's own field placeholder (#8b8b8b, 3.4:1) is
        // a known exception from before D11, listed in
        // theme-contrast.spec.ts (LIGHT_KNOWN_BELOW). Dark has none.
        const knownLight =
          scheme === "light" && i.kind === "placeholder" && i.fg === "#8b8b8b";
        if (i.ratio < MIN_CONTRAST && !knownLight) {
          failures.push(
            `${state}: "${i.text}" ${i.fg} on ${i.bg} = ${i.ratio}`,
          );
        }
      }
    };

    // The history, the labels, the prompt box, the input's placeholder,
    // Use this prompt and Start over.
    await sweep("history", [
      "Claude",
      "You",
      "You are assisting a marine biologist",
      "Answer the question…",
      "Use this prompt",
      "Start over",
    ]);

    // Waiting: the status line.
    await p.input.fill("SLOW please");
    await p.input.press("Enter");
    await expect(dialog.getByText("Claude is writing…")).toBeVisible();
    await sweep("waiting", ["Claude is writing…"]);
    await expect(dialog.getByText("Claude is writing…")).toHaveCount(0, {
      timeout: 10_000,
    });

    // An error and the copied line.
    await p.input.fill("REJECT please");
    await p.input.press("Enter");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await p.use.click();
    await sweep("error and copied", [
      "Anthropic rejected your API key",
      "Copied into the System prompt field",
    ]);

    // The unfinished note.
    await p.input.fill("UNFINISHED please");
    await p.input.press("Enter");
    await expect(dialog.getByText(/unfinished prompt/)).toBeVisible();
    await sweep("unfinished", ["unfinished prompt"]);

    expect(failures).toEqual([]);
  });
}

test("no sideways scroll: a long unbroken reply wraps inside the history box", async ({
  page,
  context,
}) => {
  const seeded = await seedRefineUser(page, context, {
    tag: "refine-wrap",
    provider: "anthropic",
    key: claude.key,
  });
  await putConversation(page, seeded.notebookId, [
    { role: "user", content: "u".repeat(1500) },
    {
      role: "assistant",
      content: `SYSTEM_PROMPT_START\n${"p".repeat(3000)}\nSYSTEM_PROMPT_END`,
      provider: "anthropic",
    },
  ]);
  const dialog = await openSettings(page);
  const p = parts(dialog);
  await expect(p.promptBox).toBeVisible();
  const overflow = (l: Locator) =>
    l.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await overflow(p.history)).toBeLessThanOrEqual(0);
  expect(await overflow(dialog)).toBeLessThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  // The history box keeps its height and scrolls inside.
  const box = (await p.history.boundingBox())!;
  expect(Math.round(box.height)).toBe(220);
  expect(
    await p.history.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
});
