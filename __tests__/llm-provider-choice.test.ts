import { describe, expect, test } from "vitest";
import { modelForTier, OPENAI_TIER_MODELS, tierModel } from "@/lib/modelTiers";
import { isLlmProviderId, providerFrom } from "@/lib/llmProviders";
import { contextWindowFor, historyTokenBudget } from "@/lib/historyBudget";

// Task 81 Stage 2. The tier-to-model choice for each provider. Like
// Task 50's modelForTier test, the property that matters is that no
// stored value -- tier or provider -- can fail a run.

describe("provider choice", () => {
  test("only the two real providers are recognised; anything else is Claude", () => {
    expect(providerFrom("openai")).toBe("openai");
    expect(providerFrom("anthropic")).toBe("anthropic");
    for (const value of [
      undefined,
      null,
      "",
      "OpenAI",
      "gemini",
      1,
      {},
      ["openai"],
    ]) {
      expect(providerFrom(value)).toBe("anthropic");
      expect(isLlmProviderId(value)).toBe(false);
    }
  });
});

describe("modelForTier with a provider", () => {
  test("ChatGPT's two tiers", () => {
    expect(modelForTier("standard", "openai")).toBe("gpt-6.1-sol");
    expect(modelForTier("economy", "openai")).toBe("gpt-6-luna");
    expect(OPENAI_TIER_MODELS).toEqual({
      standard: "gpt-6.1-sol",
      economy: "gpt-6-luna",
    });
  });

  test("Claude's are unchanged, with or without the provider named", () => {
    expect(modelForTier("standard", "anthropic")).toBe("claude-sonnet-5");
    expect(modelForTier("economy", "anthropic")).toBe("claude-haiku-4-5");
    expect(modelForTier("economy")).toBe("claude-haiku-4-5");
    expect(tierModel("standard", "anthropic")).toBe("claude-sonnet-5");
  });

  test("a bad tier falls back to Standard, and a bad provider to Claude", () => {
    expect(modelForTier("premium", "openai")).toBe("gpt-6.1-sol");
    expect(modelForTier(undefined, "openai")).toBe("gpt-6.1-sol");
    expect(modelForTier("economy", "gemini")).toBe("claude-haiku-4-5");
    expect(modelForTier(42, {})).toBe("claude-sonnet-5");
  });
});

describe("the history cap for ChatGPT", () => {
  test("its models count as 272,000 tokens, the edge of OpenAI's standard price", () => {
    expect(contextWindowFor("gpt-6.1-sol")).toBe(272_000);
    expect(contextWindowFor("gpt-6-luna")).toBe(272_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(200_000);
  });

  test("the budget is planned on that window, pictures counted the same way", () => {
    const args = {
      maxTokens: 40_000,
      systemPrompt: null,
      currentPrompt: [
        {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: "image/png",
            data: "x",
          },
        },
      ],
    };
    const gpt = historyTokenBudget({ ...args, model: "gpt-6.1-sol" });
    const claude = historyTokenBudget({ ...args, model: "claude-sonnet-5" });
    // 272,000 x 0.9 - 40,000 - (8 + 1,600 for the one picture)
    expect(gpt).toBe(244_800 - 40_000 - 1_608);
    expect(gpt - claude).toBe(72_000 * 0.9);
  });
});
