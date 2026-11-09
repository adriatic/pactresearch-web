import type { LlmProviderId } from "@/lib/llmProviders";

// Task D17i. The words for a key the service refuses (401, the
// keyRejected path), in one place: a normal Run (/api/execute, through
// lib/llm/registry.ts) and Refine with AI (/api/refine-conversation,
// through lib/refineConversation.ts) both read them from here, so they
// cannot drift apart.
//
// The service never says why it refused a key: a deleted, disabled,
// expired or mistyped key all get the same 401. So the words name the
// likely reasons without claiming one, and say where to look. No part of
// the key is ever put in them.
//
// Safe for the browser: plain strings, nothing server-only.

export const ANTHROPIC_REJECTED_KEY_MESSAGE =
  "Anthropic rejected your API key. It may have been deleted, disabled or " +
  "expired in the Anthropic console, or saved with a typing error. Compare " +
  "it with the console, then fix it in Account → Keys.";
export const ANTHROPIC_REJECTED_KEY_CODE = "anthropic_rejected_key";

export const OPENAI_REJECTED_KEY_MESSAGE =
  "OpenAI rejected your API key. It may have been deleted, disabled or " +
  "expired in the OpenAI console, or saved with a typing error. Compare it " +
  "with the console, then fix it in Account → Keys.";
export const OPENAI_REJECTED_KEY_CODE = "openai_rejected_key";

export const REJECTED_KEY_WORDS: Record<
  LlmProviderId,
  { error: string; code: string }
> = {
  anthropic: {
    error: ANTHROPIC_REJECTED_KEY_MESSAGE,
    code: ANTHROPIC_REJECTED_KEY_CODE,
  },
  openai: {
    error: OPENAI_REJECTED_KEY_MESSAGE,
    code: OPENAI_REJECTED_KEY_CODE,
  },
};
