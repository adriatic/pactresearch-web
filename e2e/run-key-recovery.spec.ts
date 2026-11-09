import { test, expect } from "@playwright/test";
import {
  openSettings,
  settingsDialog,
  startStandIn,
  type StandIn,
} from "./refineHelpers";
import {
  expectNoKey,
  expectNoSidewaysScroll,
  expectReadable,
  parts,
  REJECTED,
  refuseInRefine,
} from "./keyRecoveryHelpers";
import {
  accountDialog,
  ANSWERS,
  askButtons,
  continueButtons,
  expectAnswersScroll,
  expectInView,
  KEY_LABEL,
  prompt,
  runBar,
  runBarWords,
  saveKey,
  scrollAnswers,
  seedWithAnswers,
  typeAndRun,
} from "./runKeyRecoveryHelpers";

// Task D17k on Chrome. A Run refused for a rejected key, in a discussion
// with several long answers: the error is in view without scrolling, next
// to the composer; "Open Account → Keys" opens Account on Keys with the
// composer and the discussion untouched; saving a key and closing clears
// it; Dismiss removes it; Continue and Ask about this answer only work as
// before, with the error in view beside them. Refine with AI gets the same
// button. Replies come from local stand-ins ("REJECT" → 401).

let claude: StandIn;
let chatgpt: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  claude = await startStandIn("anthropic", 54980 + workerInfo.workerIndex);
  chatgpt = await startStandIn("openai", 55010 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
  await chatgpt?.close();
});

const NAME = { anthropic: "Claude", openai: "ChatGPT" } as const;

for (const provider of ["anthropic", "openai"] as const) {
  test(`${NAME[provider]}: the refused Run's error is in view without scrolling, beside the composer, and also with the newest answer's buttons`, async ({
    page,
    context,
  }) => {
    const stand = provider === "anthropic" ? claude : chatgpt;
    await seedWithAnswers(page, context, {
      tag: `run-key-view-${provider}`,
      provider,
      stand,
    });
    await expectAnswersScroll(page);
    // Someone reading the first answer, not at the end of the list.
    await scrollAnswers(page, "top");

    const answer = page.waitForResponse(
      (r) =>
        r.url().includes("/api/execute") && r.request().method() === "POST",
    );
    await typeAndRun(page, "REJECT test run");
    expect((await answer).status()).toBe(400);

    await expect(runBarWords(page)).toHaveText(REJECTED[provider], {
      timeout: 20_000,
    });
    await expectInView(page, runBar(page), "the error, list at its top");
    await expectInView(page, prompt(page), "the composer");
    // Not drawn a second time at the end of the list.
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    // The prompt stays in the composer.
    await expect(prompt(page)).toHaveText("REJECT test run");

    // At the end of the list: the newest answer's buttons and the error
    // are in view together.
    await scrollAnswers(page, "end");
    await expectInView(page, runBar(page), "the error, list at its end");
    await expectInView(
      page,
      continueButtons(page).last(),
      "the newest answer's Continue",
    );
    await expectInView(
      page,
      askButtons(page).last(),
      "the newest answer's Ask about this answer only",
    );

    await expectNoSidewaysScroll(page, runBarWords(page), runBar(page));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectReadable(runBar(page), REJECTED[provider]);
    }
    await expectNoKey(page, stand, "");
  });

  test(`${NAME[provider]}: Open Account → Keys shows Keys, keeps the composer and the discussion, and a saved key clears the error so Run works`, async ({
    page,
    context,
  }) => {
    const stand = provider === "anthropic" ? claude : chatgpt;
    const seeded = await seedWithAnswers(page, context, {
      tag: `run-key-open-${provider}`,
      provider,
      stand,
    });
    await typeAndRun(page, "REJECT test run");
    await expect(runBarWords(page)).toHaveText(REJECTED[provider], {
      timeout: 20_000,
    });

    await runBar(page)
      .getByRole("button", { name: "Open Account → Keys" })
      .click();
    const dialog = accountDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Keys" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The refused service's key field is there to fix (ChatGPT's section
    // opens by itself, a key being saved).
    await expect(dialog.getByLabel(KEY_LABEL[provider])).toBeVisible();
    // Behind the dialog nothing changed.
    await expect(prompt(page)).toHaveText("REJECT test run");
    await expect(
      page.getByRole("group", { name: "Active discussion" }),
    ).toContainText(seeded.discussionName);

    await saveKey(page, provider, stand.key);
    // Saved, not yet closed: the error stays until Account is closed.
    await expect(runBar(page)).toBeVisible();
    await dialog
      .getByRole("tabpanel", { name: "Keys" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(runBar(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveText("REJECT test run");

    // Run again works (the stand-in refuses only prompts with REJECT).
    await typeAndRun(page, "test run");
    await expect(continueButtons(page)).toHaveCount(ANSWERS + 1, {
      timeout: 20_000,
    });
    await expect(runBar(page)).toHaveCount(0);
  });
}

test("Dismiss removes the error and keeps the composer text", async ({
  page,
  context,
}) => {
  await seedWithAnswers(page, context, {
    tag: "run-key-dismiss",
    provider: "openai",
    stand: chatgpt,
  });
  await typeAndRun(page, "REJECT test run");
  await expect(runBarWords(page)).toHaveText(REJECTED.openai, {
    timeout: 20_000,
  });
  await runBar(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(runBar(page)).toHaveCount(0);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(prompt(page)).toHaveText("REJECT test run");
});

test("closing Account without saving, or after saving the other service's key, leaves the error", async ({
  page,
  context,
}) => {
  await seedWithAnswers(page, context, {
    tag: "run-key-other",
    provider: "openai",
    stand: chatgpt,
  });
  await typeAndRun(page, "REJECT test run");
  await expect(runBarWords(page)).toHaveText(REJECTED.openai, {
    timeout: 20_000,
  });

  const open = () =>
    runBar(page).getByRole("button", { name: "Open Account → Keys" }).click();
  const close = () =>
    accountDialog(page)
      .getByRole("tabpanel", { name: "Keys" })
      .getByRole("button", { name: "Close" })
      .click();

  await open();
  await close();
  await expect(runBarWords(page)).toHaveText(REJECTED.openai);

  await open();
  await saveKey(page, "anthropic", claude.key);
  await close();
  await expect(runBarWords(page)).toHaveText(REJECTED.openai);
});

test("Continue and Ask about this answer only work as before while the error shows, with the error in view", async ({
  page,
  context,
}) => {
  await seedWithAnswers(page, context, {
    tag: "run-key-continue",
    provider: "anthropic",
    stand: claude,
  });
  await typeAndRun(page, "REJECT test run");
  await expect(runBarWords(page)).toHaveText(REJECTED.anthropic, {
    timeout: 20_000,
  });

  // Continue: as before, it empties the composer and points it at that
  // answer (Task 49); it sends nothing.
  await scrollAnswers(page, "end");
  const executes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/execute")) executes.push(r.url());
  });
  await continueButtons(page).last().click();
  await expect(prompt(page)).toHaveText("");
  await expectInView(page, runBar(page), "the error after Continue");
  expect(executes).toEqual([]);

  // Ask about this answer only: the same, and the next question carries
  // only that answer (Task 71).
  await prompt(page).fill("still here");
  await askButtons(page).last().click();
  await expect(prompt(page)).toHaveText("");
  await expect(page.locator("[data-context-summary]")).toContainText(
    "Your choice.",
  );
  await expectInView(page, runBar(page), "the error after Ask about");
  expect(executes).toEqual([]);

  // And the next Run goes out as usual.
  await typeAndRun(page, "a follow-up");
  await expect(continueButtons(page)).toHaveCount(ANSWERS + 1, {
    timeout: 20_000,
  });
  await expect(runBar(page)).toHaveCount(0);
});

test("Refine with AI: a refused key gets Open Account → Keys, which opens Account over Notebook settings and keeps the message", async ({
  page,
  context,
}) => {
  await seedWithAnswers(page, context, {
    tag: "run-key-refine",
    provider: "openai",
    stand: chatgpt,
  });
  const dialog = await openSettings(page);
  await refuseInRefine(page, dialog, "REJECT shorter please", "openai");

  await dialog.getByRole("button", { name: "Open Account → Keys" }).click();
  const account = accountDialog(page);
  await expect(account).toBeVisible();
  await expect(account.getByRole("tab", { name: "Keys" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Account is on top: its Close is the element at its own centre.
  await expectInView(
    page,
    account.getByRole("tabpanel", { name: "Keys" }).getByRole("button", {
      name: "Close",
    }),
    "Account's Close",
  );
  await account
    .getByRole("tabpanel", { name: "Keys" })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(account).toHaveCount(0);
  await expect(settingsDialog(page)).toBeVisible();
  await expect(parts(settingsDialog(page)).input).toHaveValue(
    "REJECT shorter please",
  );
});
