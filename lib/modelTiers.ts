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

// Resolves whatever is stored on the user to a real model id. Anything
// unrecognised (never set, or a value from a future/renamed tier) falls
// back to Standard rather than failing a run.
export function modelForTier(tier: unknown): string {
  return MODEL_TIERS[isModelTier(tier) ? tier : DEFAULT_TIER].model;
}
