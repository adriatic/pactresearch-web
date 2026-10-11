// Task 81 Stage 2. The model services a user can run a prompt on.
//
// Safe for the browser: names and ids only. The calls themselves live in
// lib/llm/ (server only).
//
// The choice is stored per user in auth user_metadata as llm_provider,
// the same way the tier is stored as model_tier (lib/modelTiers.ts), so it
// needs no migration and /api/execute reads it from the user it already
// has. Anything unrecognised (never set, or a value from a later task)
// is Claude, so a stored value can never fail a run.
export const LLM_PROVIDERS = {
  anthropic: { label: "Claude" },
  openai: { label: "ChatGPT" },
} as const;

export type LlmProviderId = keyof typeof LLM_PROVIDERS;

export const DEFAULT_PROVIDER: LlmProviderId = "anthropic";

export function isLlmProviderId(value: unknown): value is LlmProviderId {
  return value === "anthropic" || value === "openai";
}

export function providerFrom(value: unknown): LlmProviderId {
  return isLlmProviderId(value) ? value : DEFAULT_PROVIDER;
}
