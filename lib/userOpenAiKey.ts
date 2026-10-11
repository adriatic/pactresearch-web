import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStoredKey, type UserKeyResult } from "./storedApiKey";

// Task 81 Stage 2. The calling user's own OpenAI key, and every message a
// ChatGPT run can end with that the user can act on. Same lookup and same
// tone as the Anthropic key (lib/userAnthropicKey.ts). Server-only.
//
// No message here ever contains the key or OpenAI's own error text: the
// error body is logged by /api/execute for support, and the user sees
// only these words.

// ChatGPT chosen, no OpenAI key saved: the run does not start.
export const OPENAI_MISSING_KEY_MESSAGE =
  "Add your OpenAI API key in Account → Keys before running prompts on ChatGPT.";
export const OPENAI_MISSING_KEY_CODE = "missing_openai_key";

export const OPENAI_UNREADABLE_KEY_MESSAGE =
  "Your saved OpenAI API key could not be read. Open Account → Keys " +
  "and save it again.";
export const OPENAI_UNREADABLE_KEY_CODE = "unreadable_openai_key";

export const OPENAI_KEY_ENCRYPTION_UNCONFIGURED_MESSAGE =
  "This server is not configured to read saved API keys, so the run did " +
  "not start. Nothing was sent to OpenAI. Please contact support.";

// OpenAI refused the key (401): revoked, mistyped, or another account's.
export const OPENAI_REJECTED_KEY_MESSAGE =
  "OpenAI rejected your API key. Check it in Account → Keys.";
export const OPENAI_REJECTED_KEY_CODE = "openai_rejected_key";

// 429 with code insufficient_quota: the key is fine, the OpenAI account
// has no API credit. OpenAI bills the API separately from a ChatGPT
// subscription, so this is the likeliest first-run failure of all.
export const OPENAI_NO_CREDIT_MESSAGE =
  "Your OpenAI account has no API credit left. Add credit on OpenAI's " +
  "billing page (platform.openai.com), then run again.";
export const OPENAI_NO_CREDIT_CODE = "openai_no_credit";

// Any other 429: too many requests or tokens per minute on this key.
export const OPENAI_RATE_LIMITED_MESSAGE =
  "OpenAI is limiting requests on your key right now. Wait a minute, " +
  "then run again.";
export const OPENAI_RATE_LIMITED_CODE = "openai_rate_limited";

// A 400 about an image: a picture in this question or in an earlier turn
// sent with it was refused.
export const OPENAI_ATTACHMENT_REFUSED_MESSAGE =
  "ChatGPT could not accept a picture sent with this question. Remove it " +
  "from the prompt, or leave earlier pictures out with Choose… under the " +
  "prompt box, then run again.";
export const OPENAI_ATTACHMENT_REFUSED_CODE = "openai_attachment_refused";

export async function resolveUserOpenAiKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserKeyResult> {
  return resolveStoredKey(supabase, userId, {
    column: "openai_key_encrypted",
    logTag: "openai-key",
    missing: {
      error: OPENAI_MISSING_KEY_MESSAGE,
      code: OPENAI_MISSING_KEY_CODE,
    },
    unreadable: {
      error: OPENAI_UNREADABLE_KEY_MESSAGE,
      code: OPENAI_UNREADABLE_KEY_CODE,
    },
    unconfigured: OPENAI_KEY_ENCRYPTION_UNCONFIGURED_MESSAGE,
  });
}
