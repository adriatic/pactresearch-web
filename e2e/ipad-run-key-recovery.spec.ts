import { test, expect } from "@playwright/test";
import { startStandIn, type StandIn } from "./refineHelpers";
import {
  expectNoSidewaysScroll,
  expectReadable,
  REJECTED,
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

// Task D17k on Nik's iPad (the webkit-ipad project, 1080x758): the
// refused Run's error is in view without scrolling, with the composer and
// with the newest answer's buttons; Open Account → Keys, a saved key
// clearing it, and Dismiss. Replies come from local stand-ins.

let claude: StandIn;
let chatgpt: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  claude = await startStandIn("anthropic", 55040 + workerInfo.workerIndex);
  chatgpt = await startStandIn("openai", 55070 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
  await chatgpt?.close();
});

for (const provider of ["anthropic", "openai"] as const) {
  const name = provider === "anthropic" ? "Claude" : "ChatGPT";
  test(`${name} on the iPad: the error is in view at the top and the end of a long discussion, fits, reads well, and Open Account → Keys then a saved key clears it`, async ({
    page,
    context,
  }) => {
    const stand = provider === "anthropic" ? claude : chatgpt;
    await seedWithAnswers(page, context, {
      tag: `ipad-run-key-${provider}`,
      provider,
      stand,
    });
    await expectAnswersScroll(page);
    await scrollAnswers(page, "top");
    await typeAndRun(page, "REJECT test run");
    await expect(runBarWords(page)).toHaveText(REJECTED[provider], {
      timeout: 20_000,
    });
    await expectInView(page, runBar(page), "the error, list at its top");
    await expectInView(page, prompt(page), "the composer");

    await scrollAnswers(page, "end");
    await expectInView(page, runBar(page), "the error, list at its end");
    await expectInView(
      page,
      continueButtons(page).last(),
      "the newest Continue",
    );
    await expectInView(
      page,
      askButtons(page).last(),
      "the newest Ask about this answer only",
    );
    await expectNoSidewaysScroll(page, runBarWords(page), runBar(page));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectReadable(runBar(page), REJECTED[provider]);
    }

    await runBar(page)
      .getByRole("button", { name: "Open Account → Keys" })
      .click();
    const dialog = accountDialog(page);
    await expect(dialog.getByRole("tab", { name: "Keys" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByLabel(KEY_LABEL[provider])).toBeVisible();
    await saveKey(page, provider, stand.key);
    await dialog
      .getByRole("tabpanel", { name: "Keys" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(runBar(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveText("REJECT test run");

    await typeAndRun(page, "test run");
    await expect(continueButtons(page)).toHaveCount(ANSWERS + 1, {
      timeout: 20_000,
    });
  });
}

test("Dismiss on the iPad removes the error and keeps the composer text", async ({
  page,
  context,
}) => {
  await seedWithAnswers(page, context, {
    tag: "ipad-run-key-dismiss",
    provider: "anthropic",
    stand: claude,
  });
  await typeAndRun(page, "REJECT test run");
  await expect(runBarWords(page)).toHaveText(REJECTED.anthropic, {
    timeout: 20_000,
  });
  await runBar(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(runBar(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveText("REJECT test run");
});
