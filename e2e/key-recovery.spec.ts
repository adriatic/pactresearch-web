import { test, expect } from "@playwright/test";
import {
  openSettings,
  QUESTION,
  settingsDialog,
  startStandIn,
  type StandIn,
} from "./refineHelpers";
import {
  closeAndReopen,
  expectNoKey,
  expectNoSidewaysScroll,
  expectReadable,
  openDiscussion,
  parts,
  REJECTED,
  refuseInRefine,
  runError,
  seedKeyUser,
  signBackIn,
  waitForFirstDiscussion,
} from "./keyRecoveryHelpers";

// Task D17i on Chrome. A key the service refuses: the words name the
// likely reasons, in Refine with AI and in a Run, for Claude and ChatGPT,
// with no part of the key anywhere. The unsent Refine message survives
// closing Notebook settings while the page stays open, and is dropped by
// a successful send, Start over, another notebook, sign-out and reload.
// Replies come from local stand-ins; "REJECT" makes them answer 401.

let claude: StandIn;
let chatgpt: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  // Ports of their own, clear of the other specs' stand-ins.
  claude = await startStandIn("anthropic", 54860 + workerInfo.workerIndex);
  chatgpt = await startStandIn("openai", 54890 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
  await chatgpt?.close();
});

const stand = (provider: "anthropic" | "openai") =>
  provider === "anthropic" ? claude : chatgpt;

for (const provider of ["anthropic", "openai"] as const) {
  const name = provider === "anthropic" ? "Claude" : "ChatGPT";

  test(`${name}, Refine with AI: a refused key gets the new words, no part of the key, and the typed text comes back after closing`, async ({
    page,
    context,
  }) => {
    await seedKeyUser(page, context, {
      tag: `key-refine-${provider}`,
      provider,
      stand: stand(provider),
    });
    let dialog = await openSettings(page);
    const answer = await refuseInRefine(
      page,
      dialog,
      "REJECT my research domain is coral reefs",
      provider,
    );
    await expectNoKey(page, stand(provider), answer);

    // Close (as when going to Account → Keys) and open again: the
    // message is back, and no error is shown any more.
    dialog = await closeAndReopen(page);
    const p = parts(dialog);
    await expect(p.input).toHaveValue(
      "REJECT my research domain is coral reefs",
    );
    await expect(p.alert).toHaveCount(0);

    // Typing after reopening is never overwritten, and is what is kept.
    await p.input.press("End");
    await p.input.pressSequentially(" and fish");
    await expect(p.input).toHaveValue(
      "REJECT my research domain is coral reefs and fish",
    );
    dialog = await closeAndReopen(page);
    await expect(parts(dialog).input).toHaveValue(
      "REJECT my research domain is coral reefs and fish",
    );
  });

  test(`${name}, a Run: a refused key gets the same new words, and no part of the key`, async ({
    page,
    context,
  }) => {
    await seedKeyUser(page, context, {
      tag: `key-run-${provider}`,
      provider,
      stand: stand(provider),
    });
    await page.getByLabel("Prompt").fill("REJECT this run");
    const answer = page.waitForResponse(
      (r) =>
        r.url().includes("/api/execute") && r.request().method() === "POST",
    );
    const runButton = page
      .locator("header")
      .getByRole("button", { name: "Run" });
    await expect(runButton).toBeEnabled();
    await runButton.click();
    const response = await answer;
    expect(response.status()).toBe(400);
    await expect(runError(page)).toHaveText(REJECTED[provider], {
      timeout: 20_000,
    });
    await expectNoKey(page, stand(provider), await response.text());
    // The prompt is kept, as before.
    await expect(page.getByLabel("Prompt")).toContainText("REJECT this run");
  });
}

test("a successful send clears the kept message", async ({ page, context }) => {
  await seedKeyUser(page, context, {
    tag: "key-sent",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  await refuseInRefine(page, dialog, "REJECT coral reefs", "anthropic");
  dialog = await closeAndReopen(page);
  const p = parts(dialog);
  await expect(p.input).toHaveValue("REJECT coral reefs");

  // Fixed (here: the word that makes the stand-in refuse is removed) and
  // sent: the reply comes, and nothing is kept any more.
  await p.input.fill("Coral reefs");
  await expect(p.send).toBeEnabled();
  await p.input.press("Enter");
  await expect(p.history).toContainText(QUESTION.anthropic);
  await expect(p.input).toHaveValue("");
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("");
});

test("Start over (confirmed) clears the kept message", async ({
  page,
  context,
}) => {
  await seedKeyUser(page, context, {
    tag: "key-start-over",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  let p = parts(dialog);
  await p.input.fill("Coral reefs");
  await expect(p.send).toBeEnabled();
  await p.input.press("Enter");
  await expect(p.history).toContainText(QUESTION.anthropic);
  await refuseInRefine(page, dialog, "REJECT a field ecologist", "anthropic");
  dialog = await closeAndReopen(page);
  p = parts(dialog);
  await expect(p.input).toHaveValue("REJECT a field ecologist");

  // "Keep it" keeps the message too.
  await p.startOver.click();
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(p.input).toHaveValue("REJECT a field ecologist");

  await p.startOver.click();
  await dialog
    .getByRole("group", { name: "Start over" })
    .getByRole("button", { name: "Start over" })
    .click();
  await expect(p.history).toHaveCount(0);
  await expect(p.input).toHaveValue("");
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("");
});

test("each notebook has its own: opening another notebook drops the kept message", async ({
  page,
  context,
}) => {
  const seeded = await seedKeyUser(page, context, {
    tag: "key-other-notebook",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  await refuseInRefine(
    page,
    dialog,
    "REJECT first notebook words",
    "anthropic",
  );
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("REJECT first notebook words");
  await parts(dialog).cancel.click();

  // The other notebook: its Refine input is empty.
  await openDiscussion(
    page,
    seeded.other.notebookName,
    seeded.other.discussionName,
  );
  dialog = await openSettings(page);
  await expect(parts(dialog).input).toBeEnabled();
  await expect(parts(dialog).input).toHaveValue("");
  await parts(dialog).cancel.click();

  // And back to the first: the message was dropped.
  await openDiscussion(page, seeded.notebookName, seeded.discussionName);
  dialog = await openSettings(page);
  await expect(parts(dialog).input).toBeEnabled();
  await expect(parts(dialog).input).toHaveValue("");
});

test("another discussion in the same notebook keeps the message", async ({
  page,
  context,
}) => {
  const seeded = await seedKeyUser(page, context, {
    tag: "key-same-notebook",
    provider: "anthropic",
    stand: claude,
  });
  const second = `E2E key-same-notebook second discussion ${Date.now()}`;
  const { error } = await seeded.admin.from("discussions").insert({
    notebook_id: seeded.notebookId,
    user_id: seeded.userId,
    name: second,
    total_time_ms: 0,
  });
  if (error) throw error;
  // The tree shows the new discussion after a reload, before any message.
  await page.reload();
  await waitForFirstDiscussion(page);
  await openDiscussion(page, seeded.notebookName, seeded.discussionName);

  let dialog = await openSettings(page);
  await refuseInRefine(page, dialog, "REJECT same notebook words", "anthropic");
  await parts(dialog).cancel.click();
  await openDiscussion(page, seeded.notebookName, second);
  dialog = await openSettings(page);
  await expect(parts(dialog).input).toBeEnabled();
  await expect(parts(dialog).input).toHaveValue("REJECT same notebook words");
});

test("signing out drops the kept message", async ({ page, context }) => {
  const seeded = await seedKeyUser(page, context, {
    tag: "key-sign-out",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  await refuseInRefine(page, dialog, "REJECT before signing out", "anthropic");
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("REJECT before signing out");
  await parts(dialog).cancel.click();

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect(page).toHaveURL(/\/login$/);

  await signBackIn(context, seeded);
  await page.goto("/");
  await waitForFirstDiscussion(page);
  await openDiscussion(page, seeded.notebookName, seeded.discussionName);
  dialog = await openSettings(page);
  await expect(parts(dialog).input).toBeEnabled();
  await expect(parts(dialog).input).toHaveValue("");
});

test("reloading the page drops the kept message", async ({ page, context }) => {
  const seeded = await seedKeyUser(page, context, {
    tag: "key-reload",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  await refuseInRefine(page, dialog, "REJECT before reloading", "anthropic");
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("REJECT before reloading");
  await parts(dialog).cancel.click();

  await page.reload();
  await waitForFirstDiscussion(page);
  await openDiscussion(page, seeded.notebookName, seeded.discussionName);
  dialog = await openSettings(page);
  await expect(parts(dialog).input).toBeEnabled();
  await expect(parts(dialog).input).toHaveValue("");
});

test("a refusal that arrives after closing and reopening does not overwrite what was typed since", async ({
  page,
  context,
}) => {
  await seedKeyUser(page, context, {
    tag: "key-late",
    provider: "anthropic",
    stand: claude,
  });
  let dialog = await openSettings(page);
  let p = parts(dialog);
  await expect(p.input).toBeEnabled();
  // SLOW: the stand-in waits 3 seconds, then refuses.
  await p.input.fill("SLOW REJECT first words");
  await expect(p.send).toBeEnabled();
  const answer = page.waitForResponse(
    (r) =>
      r.url().includes("/api/refine-conversation") &&
      r.request().method() === "POST",
  );
  await p.input.press("Enter");
  await expect(dialog.getByText("Claude is writing…")).toBeVisible();

  // Closed while the reply is on its way, and opened again: the message
  // is still held.
  dialog = await closeAndReopen(page);
  p = parts(dialog);
  await expect(p.input).toHaveValue("SLOW REJECT first words");
  await p.input.fill("Second words");
  expect((await answer).status()).toBe(400);

  // The refusal changed nothing: not the input, not what is kept.
  await page.waitForTimeout(300);
  await expect(p.input).toHaveValue("Second words");
  dialog = await closeAndReopen(page);
  await expect(parts(dialog).input).toHaveValue("Second words");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the longer words fit and are readable on a ${scheme} device, in Notebook settings and in the discussion`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await seedKeyUser(page, context, {
      tag: `key-layout-${scheme}`,
      provider: "openai",
      stand: chatgpt,
    });
    // ChatGPT's words are the longest (the reason is added).
    const dialog = await openSettings(page);
    await refuseInRefine(page, dialog, "REJECT layout", "openai");
    const refineAlert = parts(dialog).alert;
    await expectNoSidewaysScroll(page, refineAlert, settingsDialog(page));
    await expectReadable(dialog, REJECTED.openai);
    await parts(dialog).cancel.click();

    await page.getByLabel("Prompt").fill("REJECT layout run");
    await page.locator("header").getByRole("button", { name: "Run" }).click();
    await expect(runError(page)).toHaveText(REJECTED.openai, {
      timeout: 20_000,
    });
    await expectNoSidewaysScroll(page, runError(page), page.locator("main"));
    await expectReadable(page.locator("main"), REJECTED.openai);
  });
}
