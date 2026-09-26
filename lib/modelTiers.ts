// Task 50 item C. The two model tiers a user can pick between.
//
// Model IDs are real, current Anthropic IDs, not pact-mac's screenshot
// text (its strings come from its own config and do not match what this
// app runs).
//
// Standard is deliberately the model pact-web ALREADY used before this
// task (claude-sonnet-4-6), so choosing Standard changes nothing for
// anyone. Economy adds a cheaper, faster option below it.
//
// Note for review: claude-sonnet-5 also exists and is both newer and
// cheaper than claude-sonnet-4-6 ($2/$10 per MTok against $3/$15).
// Promoting Standard to it is a reasonable call, but it would change the
// model behind every existing run, so it is Nik's decision rather than
// something to slip in under a UI task.
export const MODEL_TIERS = {
  standard: {
    label: "Standard",
    model: "claude-sonnet-4-6",
    description: "Highest quality. The model pact-web has always used.",
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
