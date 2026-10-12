import { describe, it, expect } from "vitest";
import { providerForModel, responseLlmLabel } from "@/lib/llmProviders";

// Task 86. The label on each response cell, from what the row stores.
describe("responseLlmLabel", () => {
  it("names the service and the model that answered", () => {
    expect(
      responseLlmLabel({
        model: "claude-sonnet-5",
        resolved_model: "claude-sonnet-5",
      }),
    ).toBe("Claude · claude-sonnet-5");
    expect(
      responseLlmLabel({ model: "gpt-6.1-sol", resolved_model: "gpt-6.1-sol" }),
    ).toBe("ChatGPT · gpt-6.1-sol");
    expect(
      responseLlmLabel({ model: "gpt-6-luna", resolved_model: "gpt-6-luna" }),
    ).toBe("ChatGPT · gpt-6-luna");
  });

  it("prefers the model that answered over the one asked for", () => {
    expect(
      responseLlmLabel({
        model: "claude-haiku-4-5",
        resolved_model: "claude-haiku-4-5-20251001",
      }),
    ).toBe("Claude · claude-haiku-4-5-20251001");
  });

  it("falls back to the model asked for when none was reported", () => {
    expect(
      responseLlmLabel({ model: "gpt-6.1-sol", resolved_model: null }),
    ).toBe("ChatGPT · gpt-6.1-sol");
    expect(responseLlmLabel({ model: "claude-sonnet-4-6" })).toBe(
      "Claude · claude-sonnet-4-6",
    );
  });

  it("shows the service alone when there is no real model name", () => {
    expect(responseLlmLabel({ model: "claude", resolved_model: null })).toBe(
      "Claude",
    );
    expect(responseLlmLabel({ model: "gpt", resolved_model: null })).toBe(
      "ChatGPT",
    );
    expect(responseLlmLabel({ model: "  ", resolved_model: "" })).toBe(
      "Claude",
    );
  });

  it("is Claude when nothing is stored at all", () => {
    expect(responseLlmLabel({})).toBe("Claude");
    expect(responseLlmLabel({ model: null, resolved_model: null })).toBe(
      "Claude",
    );
  });
});

describe("providerForModel", () => {
  it("reads ChatGPT from OpenAI model names, and Claude from everything else", () => {
    for (const m of [
      "gpt-6.1-sol",
      "gpt",
      "GPT-4o",
      "chatgpt-4o-latest",
      "o3",
      "o4-mini",
    ]) {
      expect(providerForModel(m), m).toBe("openai");
    }
    for (const m of [
      "claude-sonnet-5",
      "claude",
      "claude-e2e-mock",
      "",
      null,
      undefined,
      "opus",
      "orca",
    ]) {
      expect(providerForModel(m), String(m)).toBe("anthropic");
    }
  });
});
