import { providerFrom, type LlmProviderId } from "./llmProviders";

// Task 50 item C. The two model tiers a user can pick between.
//
// Model IDs are real, current Anthropic IDs, not pact-mac's screenshot
// text (its strings come from its own config and do not match what this
// app runs).
//
// Standard is claude-sonnet-5. Task 50 shipped it as claude-sonnet-4-6
// -- the model pact-web had always used -- and flagged that
// claude-sonnet-5 is both newer and cheaper ($2/$10 per MTok against
// $3/$15); Nik chose to move to it. This is the model behind EVERY run
// for anyone who has not picked Economy, including users who never open
// the picker, so it is a deliberate product change rather than a
// default nobody chose.
export const MODEL_TIERS = {
  standard: {
    label: "Standard",
    model: "claude-sonnet-5",
    description:
      "Highest quality. Best for detailed analysis and long documents.",
  },
  economy: {
    label: "Economy",
    model: "claude-haiku-4-5",
    description: "Faster and cheaper. Best for quick or routine prompts.",
  },
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

export const DEFAULT_TIER: ModelTier = "standard";

export function isModelTier(value: unknown): value is ModelTier {
  return value === "standard" || value === "economy";
}

// Task 81 Stage 2. The same two tiers on ChatGPT. Checked against
// OpenAI's model list and the openai package's own model names
// (7.32.0) on 2026-10-11, not copied from pact-mac's gpt-4.1:
//   Standard -- gpt-6.1-sol: OpenAI's "near-Astra performance for
//     complex work at a lower cost", $2/$10 per MTok, the same price as
//     claude-sonnet-5. gpt-6-astra, the top model, is $10/$50.
//   Economy -- gpt-6-luna: "most efficient model for focused,
//     high-volume tasks", $0.10/$0.50 per MTok.
// Both take pictures and stream through Chat Completions.
export const OPENAI_TIER_MODELS: Record<ModelTier, string> = {
  standard: "gpt-6.1-sol",
  economy: "gpt-6-luna",
};

// The model a tier means on a provider: Claude's from MODEL_TIERS, unchanged.
export function tierModel(tier: ModelTier, provider: LlmProviderId): string {
  return provider === "openai"
    ? OPENAI_TIER_MODELS[tier]
    : MODEL_TIERS[tier].model;
}

// Resolves whatever is stored on the user to a real model id. Anything
// unrecognised (never set, or a value from a future/renamed tier) falls
// back to Standard rather than failing a run; an unrecognised provider
// is Claude. Without a provider (Refine with AI, draft-writing) it is
// Claude's model, as before.
export function modelForTier(tier: unknown, provider?: unknown): string {
  return tierModel(
    isModelTier(tier) ? tier : DEFAULT_TIER,
    providerFrom(provider),
  );
}
