import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmProviderId } from "@/lib/llmProviders";
import {
  REJECTED_KEY_CODE,
  REJECTED_KEY_MESSAGE,
  resolveUserAnthropicKey,
} from "@/lib/userAnthropicKey";
import type { UserKeyResult } from "@/lib/storedApiKey";
import {
  OPENAI_ATTACHMENT_REFUSED_CODE,
  OPENAI_ATTACHMENT_REFUSED_MESSAGE,
  OPENAI_NO_CREDIT_CODE,
  OPENAI_NO_CREDIT_MESSAGE,
  OPENAI_RATE_LIMITED_CODE,
  OPENAI_RATE_LIMITED_MESSAGE,
  OPENAI_REJECTED_KEY_CODE,
  OPENAI_REJECTED_KEY_MESSAGE,
  resolveUserOpenAiKey,
} from "@/lib/userOpenAiKey";
import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import type { LlmProvider, ProviderRefusalReason } from "./provider";

// Task 81 Stage 2. Everything /api/execute needs per provider: the call,
// the user's key for it, and the words for a refusal the user can act on.
// Server-only.

type UserMessage = { error: string; code: string };

export interface ProviderEntry {
  provider: LlmProvider;
  resolveKey: (
    supabase: SupabaseClient,
    userId: string,
  ) => Promise<UserKeyResult>;
  rejectedKey: UserMessage;
  // Messages for ProviderRequestError.reason. A reason with no message
  // here keeps the generic "Execution failed" and its error id.
  refusals: Partial<Record<ProviderRefusalReason, UserMessage>>;
}

export const PROVIDER_ENTRIES: Record<LlmProviderId, ProviderEntry> = {
  anthropic: {
    provider: anthropicProvider,
    resolveKey: resolveUserAnthropicKey,
    rejectedKey: { error: REJECTED_KEY_MESSAGE, code: REJECTED_KEY_CODE },
    // None: Claude's messages are unchanged by Task 81.
    refusals: {},
  },
  openai: {
    provider: openaiProvider,
    resolveKey: resolveUserOpenAiKey,
    rejectedKey: {
      error: OPENAI_REJECTED_KEY_MESSAGE,
      code: OPENAI_REJECTED_KEY_CODE,
    },
    refusals: {
      no_credit: {
        error: OPENAI_NO_CREDIT_MESSAGE,
        code: OPENAI_NO_CREDIT_CODE,
      },
      rate_limited: {
        error: OPENAI_RATE_LIMITED_MESSAGE,
        code: OPENAI_RATE_LIMITED_CODE,
      },
      attachment_refused: {
        error: OPENAI_ATTACHMENT_REFUSED_MESSAGE,
        code: OPENAI_ATTACHMENT_REFUSED_CODE,
      },
    },
  },
};
