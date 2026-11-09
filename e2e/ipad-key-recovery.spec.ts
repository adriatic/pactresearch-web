import { test, expect } from "@playwright/test";
import {
  openSettings,
  settingsDialog,
  startStandIn,
  type StandIn,
} from "./refineHelpers";
import {
  closeAndReopen,
  expectNoKey,
  expectNoSidewaysScroll,
  expectReadable,
  parts,
  REJECTED,
  refuseInRefine,
  runError,
  seedKeyUser,
} from "./keyRecoveryHelpers";

// Task D17i on Nik's iPad (the webkit-ipad project, 1080x758). The longer
// refused-key words fit, with nothing scrolling sideways, and reach 4.5:1
// in light and dark, in Notebook settings and in the discussion's error
// box; the unsent Refine message comes back after closing and reopening.
// Replies come from local stand-ins; "REJECT" makes them answer 401.

let claude: StandIn;
let chatgpt: StandIn;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  claude = await startStandIn("anthropic", 54920 + workerInfo.workerIndex);
  chatgpt = await startStandIn("openai", 54950 + workerInfo.workerIndex);
});

test.afterAll(async () => {
  await claude?.close();
  await chatgpt?.close();
});

for (const provider of ["anthropic", "openai"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    const name = provider === "anthropic" ? "Claude" : "ChatGPT";
    test(`${name} on a ${scheme} iPad: the words fit and are readable in Notebook settings and in a Run, and the message comes back`, async ({
      page,
      context,
    }) => {
      const stand = provider === "anthropic" ? claude : chatgpt;
      await page.emulateMedia({ colorScheme: scheme });
      await seedKeyUser(page, context, {
        tag: `ipad-key-${provider}-${scheme}`,
        provider,
        stand,
      });

      let dialog = await openSettings(page);
      const answer = await refuseInRefine(
        page,
        dialog,
        "REJECT on the iPad",
        provider,
      );
      await expectNoKey(page, stand, answer);
      await expectNoSidewaysScroll(
        page,
        parts(dialog).alert,
        settingsDialog(page),
      );
      await expectReadable(dialog, REJECTED[provider]);

      dialog = await closeAndReopen(page);
      await expect(parts(dialog).input).toHaveValue("REJECT on the iPad");
      await parts(dialog).cancel.click();

      await page.getByLabel("Prompt").fill("REJECT this run");
      await page.locator("header").getByRole("button", { name: "Run" }).click();
      await expect(runError(page)).toHaveText(REJECTED[provider], {
        timeout: 20_000,
      });
      await expectNoSidewaysScroll(page, runError(page), page.locator("main"));
      await expectReadable(page.locator("main"), REJECTED[provider]);
    });
  }
}
