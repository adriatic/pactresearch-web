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

// Task 86. Which service a stored response came from, read from its model
// name -- responses.model is always set (not null) and names the service:
// claude-... (or the old default "claude") for Claude, gpt-... for
// ChatGPT. Older PACT apps also wrote a bare "gpt"; o1/o3/o4 are
// OpenAI's reasoning-model names. Anything else is Claude, the only
// service pact-web had before Task 81, so no response needs a new column.
export function providerForModel(
  model: string | null | undefined,
): LlmProviderId {
  const name = (model ?? "").trim().toLowerCase();
  return /^(gpt|chatgpt|o\d)(\b|-|$)/.test(name) ? "openai" : DEFAULT_PROVIDER;
}

// Bare service words some older files carry instead of a model name.
const NOT_A_MODEL_NAME = new Set([
  "claude",
  "anthropic",
  "gpt",
  "chatgpt",
  "openai",
]);

// Task 86. The quiet label on each response cell: "Claude · claude-sonnet-5"
// or "ChatGPT · gpt-6.1-sol". The model is the one that actually answered
// (resolved_model, what the service reported), falling back to the one
// asked for. With no real model name, the service alone.
export function responseLlmLabel(row: {
  model?: string | null;
  resolved_model?: string | null;
}): string {
  const name = row.resolved_model?.trim() || row.model?.trim() || "";
  const provider = providerForModel(name || row.model);
  const label = LLM_PROVIDERS[provider].label;
  return name && !NOT_A_MODEL_NAME.has(name.toLowerCase())
    ? `${label} · ${name}`
    : label;
}
