import { test, expect } from "@playwright/test";
import type { LlmProviderId } from "@/lib/llmProviders";
import { REFINE_INCOMPLETE_NOTE } from "@/lib/refineConversation";
import {
  doubledStartReply,
  getConversation,
  openSettings,
  PROMPT,
  QUESTION,
  seedRefineUser,
  startStandIn,
  type StandIn,
} from "./refineHelpers";

// Task D17g. Nik's Preview trial: the model wrote the system prompt in the
// right place but closed it with SYSTEM_PROMPT_START a second time. That
// slip is read as a complete prompt: its own box, "Use this prompt", and
// no unfinished-prompt note. The stand-in answers the second message with
// that reply; no real model is called.

const standIns: Partial<Record<LlmProviderId, StandIn>> = {};

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  standIns.anthropic = await startStandIn(
    "anthropic",
    54800 + workerInfo.workerIndex,
  );
  standIns.openai = await startStandIn(
    "openai",
    54830 + workerInfo.workerIndex,
  );
});

test.afterAll(async () => {
  await standIns.anthropic?.close();
  await standIns.openai?.close();
});

const LABEL = { anthropic: "Claude", openai: "ChatGPT" } as const;

for (const provider of ["anthropic", "openai"] as const) {
  test(`${LABEL[provider]} account: a prompt closed with the start marker twice gets its box and Use this prompt, with no unfinished note`, async ({
    page,
    context,
  }) => {
    const standIn = standIns[provider]!;
    const seeded = await seedRefineUser(page, context, {
      tag: `refine-markers-${provider}`,
      provider,
      key: standIn.key,
    });

    const dialog = await openSettings(page);
    const input = dialog.getByRole("textbox", { name: "Refine with AI" });
    const field = dialog.getByLabel("System prompt:");
    await field.fill("My own older text.");

    await input.fill("Coral reef recovery.");
    await input.press("Enter");
    await expect(
      dialog.getByRole("log", { name: "Refine with AI conversation" }),
    ).toContainText(QUESTION[provider]);

    await input.fill("A field ecologist, cautious. DOUBLESTART");
    await input.press("Enter");

    // The prompt in its own box, without the marker lines.
    const box = dialog.locator("[data-refine-prompt]");
    await expect(box).toHaveText(PROMPT[provider], { timeout: 15_000 });
    await expect(box).toHaveCount(1);
    await expect(
      dialog.locator('[data-refine-message="assistant"]').last(),
    ).not.toContainText("SYSTEM_PROMPT_START");
    await expect(
      dialog.getByText("Would you like to refine this further?"),
    ).toBeVisible();
    await expect(dialog.getByText(REFINE_INCOMPLETE_NOTE)).toHaveCount(0);

    // Use this prompt replaces the System prompt field.
    await dialog.getByRole("button", { name: "Use this prompt" }).click();
    await expect(field).toHaveValue(PROMPT[provider]);
    await expect(
      dialog.getByText("Copied into the System prompt field. Save to keep it."),
    ).toBeVisible();

    // Stored as the model wrote it (the reading is done when shown).
    const stored = await getConversation(page, seeded.notebookId);
    expect(stored.at(-1)).toEqual({
      role: "assistant",
      content: doubledStartReply(provider),
      provider,
    });
  });
}
