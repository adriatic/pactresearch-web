import { describe, expect, test } from "vitest";
import { PROVIDER_ENTRIES } from "@/lib/llm/registry";
import { refineWords } from "@/lib/refineConversation";
import { REJECTED_KEY_WORDS } from "@/lib/rejectedKeyWords";

// Task D17i. A key the service refuses (401): the words name the likely
// reasons without claiming one, and a normal Run and Refine with AI show
// exactly the same words, from one place.

const CLAUDE =
  "Anthropic rejected your API key. It may have been deleted, disabled or expired in the Anthropic console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys.";
const CHATGPT =
  "OpenAI rejected your API key. It may have been deleted, disabled or expired in the OpenAI console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys.";

describe("the words for a refused key", () => {
  test.each([
    ["anthropic", CLAUDE, "anthropic_rejected_key"],
    ["openai", CHATGPT, "openai_rejected_key"],
  ] as const)(
    "%s: the exact words and code, in the shared place, a Run and Refine",
    (provider, error, code) => {
      expect(REJECTED_KEY_WORDS[provider]).toEqual({ error, code });
      expect(PROVIDER_ENTRIES[provider].rejectedKey).toEqual({ error, code });
      expect(refineWords("rejected_key", provider)).toEqual({ error, code });
    },
  );

  test.each(["anthropic", "openai"] as const)(
    "%s: a Run and Refine with AI use the same words",
    (provider) => {
      expect(PROVIDER_ENTRIES[provider].rejectedKey).toEqual(
        refineWords("rejected_key", provider),
      );
    },
  );

  test("ChatGPT: Refine adds OpenAI's reason exactly as a Run does", () => {
    // /api/execute: `${message} (${reasonLabel}: ${providerCode})`.
    const run = PROVIDER_ENTRIES.openai;
    expect(refineWords("rejected_key", "openai", "invalid_api_key").error).toBe(
      `${run.rejectedKey.error} (${run.reasonLabel}: invalid_api_key)`,
    );
    expect(refineWords("rejected_key", "openai", "invalid_api_key").error).toBe(
      `${CHATGPT} (OpenAI: invalid_api_key)`,
    );
  });

  test("Claude: no reason is added, in Refine or in a Run", () => {
    expect(PROVIDER_ENTRIES.anthropic.reasonLabel).toBeNull();
    expect(refineWords("rejected_key", "anthropic", "x").error).toBe(CLAUDE);
  });

  test("no part of a key could be in the words: no key prefix, no hint", () => {
    for (const { error } of Object.values(REJECTED_KEY_WORDS)) {
      expect(error).not.toMatch(/sk-|…/);
    }
  });
});
