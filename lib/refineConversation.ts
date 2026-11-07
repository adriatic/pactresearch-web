import { LLM_PROVIDERS, type LlmProviderId } from "@/lib/llmProviders";
import {
  REFINE_MISSING_KEY_CODE,
  REFINE_MISSING_KEY_MESSAGE,
} from "@/lib/refineDraft";

// Task D17b. Refine with AI as a conversation: the parts the route
// (/api/refine-conversation, D17d) and both dialogs (D17e, D17f) share.
// Design: cc-reports summary-task-D17a-refine-design.md.
//
// Safe for the browser: no I/O, no key, nothing server-only. The key
// messages it repeats live in server-only modules (lib/userAnthropicKey.ts
// and lib/userOpenAiKey.ts decrypt keys), so they are copied here and
// __tests__/refine-conversation.test.ts keeps each copy equal to its
// original.

// ---------------------------------------------------------------- messages

export type RefineProvider = LlmProviderId;

// One turn. provider is the service that wrote an assistant reply, so a
// conversation that changes service part-way can label each reply; it is
// never allowed on a user message.
export interface RefineMessage {
  role: "user" | "assistant";
  content: string;
  provider?: RefineProvider;
}

// ------------------------------------------------------------------ limits

// A stored conversation holds at most this many messages (20 exchanges).
// A conversation sent by the browser starts and ends with the user, so it
// has an odd count: at most 39, which the reply brings to 40.
export const REFINE_MAX_MESSAGES = 40;
export const REFINE_MAX_USER_CHARS = 2000;
export const REFINE_MAX_ASSISTANT_CHARS = 12000;
// All contents together.
export const REFINE_MAX_TOTAL_CHARS = 60000;
// max_tokens (Anthropic) / max_completion_tokens (OpenAI) for one reply.
export const REFINE_MAX_OUTPUT_TOKENS = 4096;
// One attempt, then the timeout words below.
export const REFINE_TIMEOUT_MS = 60000;

// ------------------------------------------------------------------ checks

// Why a conversation was refused. A code only: never any of the text.
export type ConversationProblem =
  | "not_a_list"
  | "empty"
  | "bad_message" // not an object, unknown role, content not a string, or an unknown field
  | "empty_message" // content is blank
  | "provider_on_user_message"
  | "unknown_provider"
  | "first_not_user"
  | "not_alternating"
  | "last_not_user"
  | "too_many_messages"
  | "user_message_too_long"
  | "assistant_message_too_long"
  | "total_too_long";

export type ConversationCheck =
  | { ok: true; messages: RefineMessage[] }
  | { ok: false; reason: ConversationProblem };

const MESSAGE_FIELDS = new Set(["role", "content", "provider"]);

function isProvider(value: unknown): value is RefineProvider {
  return typeof value === "string" && Object.hasOwn(LLM_PROVIDERS, value);
}

// The checks both kinds of conversation share. Returns a clean copy, with
// only the three known fields, so nothing extra is ever stored.
function checkMessages(
  value: unknown,
  { lastMustBeUser }: { lastMustBeUser: boolean },
): ConversationCheck {
  if (!Array.isArray(value)) return { ok: false, reason: "not_a_list" };
  if (value.length > REFINE_MAX_MESSAGES) {
    return { ok: false, reason: "too_many_messages" };
  }

  const messages: RefineMessage[] = [];
  let total = 0;
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, reason: "bad_message" };
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !MESSAGE_FIELDS.has(key))) {
      return { ok: false, reason: "bad_message" };
    }
    const { role, content } = record;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      return { ok: false, reason: "bad_message" };
    }
    if (content.trim() === "") return { ok: false, reason: "empty_message" };

    const hasProvider = record.provider !== undefined;
    if (hasProvider && role === "user") {
      return { ok: false, reason: "provider_on_user_message" };
    }
    if (hasProvider && !isProvider(record.provider)) {
      return { ok: false, reason: "unknown_provider" };
    }

    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected) {
      return {
        ok: false,
        reason: index === 0 ? "first_not_user" : "not_alternating",
      };
    }

    if (role === "user" && content.length > REFINE_MAX_USER_CHARS) {
      return { ok: false, reason: "user_message_too_long" };
    }
    if (role === "assistant" && content.length > REFINE_MAX_ASSISTANT_CHARS) {
      return { ok: false, reason: "assistant_message_too_long" };
    }
    total += content.length;

    messages.push(
      hasProvider
        ? { role, content, provider: record.provider as RefineProvider }
        : { role, content },
    );
  }

  if (total > REFINE_MAX_TOTAL_CHARS) {
    return { ok: false, reason: "total_too_long" };
  }
  if (lastMustBeUser) {
    if (messages.length === 0) return { ok: false, reason: "empty" };
    if (messages.at(-1)!.role !== "user") {
      return { ok: false, reason: "last_not_user" };
    }
  }
  return { ok: true, messages };
}

// A conversation sent by the browser, to be answered: at least one
// message, from the user first and last, alternating, within every limit.
// Never trusted as stored data: the route checks it on every request.
export function checkSentConversation(value: unknown): ConversationCheck {
  return checkMessages(value, { lastMustBeUser: true });
}

// A conversation read back from storage: the same rules, but it may be
// empty (none yet) and usually ends with the assistant's reply.
export function checkStoredConversation(value: unknown): ConversationCheck {
  return checkMessages(value, { lastMustBeUser: false });
}

// ----------------------------------------------------------------- markers

export const PROMPT_START_MARKER = "SYSTEM_PROMPT_START";
export const PROMPT_END_MARKER = "SYSTEM_PROMPT_END";

export interface ExtractedPrompt {
  // The last complete START ... END pair's text, trimmed; null if none
  // (or if the pair holds only blank space).
  prompt: string | null;
  // A START with no END after it: the model began a prompt and did not
  // finish it.
  incomplete: boolean;
}

// A marker counts only on a line of its own (spaces around it allowed),
// so a reply that merely mentions the two words in a sentence ("I will
// put it between SYSTEM_PROMPT_START and SYSTEM_PROMPT_END") is not read
// as a prompt. Text before START and after END is ignored.
function markerLine(line: string): "start" | "end" | null {
  const trimmed = line.trim();
  if (trimmed === PROMPT_START_MARKER) return "start";
  if (trimmed === PROMPT_END_MARKER) return "end";
  return null;
}

// The marked prompt in one reply.
export function extractPrompt(reply: string): ExtractedPrompt {
  const lines = reply.split(/\r?\n/);
  let prompt: string | null = null;
  let openAt: number | null = null;

  for (const [index, line] of lines.entries()) {
    const marker = markerLine(line);
    if (marker === "start") {
      // A second START before an END restarts the prompt from here.
      openAt = index;
    } else if (marker === "end" && openAt !== null) {
      const text = lines
        .slice(openAt + 1, index)
        .join("\n")
        .trim();
      prompt = text === "" ? null : text;
      openAt = null;
    }
    // An END with no START before it closes nothing.
  }
  return { prompt, incomplete: openAt !== null };
}

// The prompt "Use this prompt" takes: the newest assistant message with a
// complete pair, and where it is. Earlier replies count, so a later
// question ("Shall I refine it further?") does not hide the prompt.
export function latestPrompt(
  messages: readonly RefineMessage[],
): { prompt: string; index: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const { prompt } = extractPrompt(message.content);
    if (prompt !== null) return { prompt, index };
  }
  return null;
}

// ------------------------------------------------------------------ labels

// "Claude" or "ChatGPT": the service's name as the app shows it elsewhere.
export function refineProviderLabel(provider: RefineProvider): string {
  return LLM_PROVIDERS[provider].label;
}

// The label over one message: the service for an assistant reply that
// records it, null for a user message or an older reply without one.
export function refineMessageLabel(message: RefineMessage): string | null {
  return message.role === "assistant" && message.provider
    ? refineProviderLabel(message.provider)
    : null;
}

// ------------------------------------------------------------------- words

// Every case the route or a dialog can end a turn with.
export type RefineCase =
  | "missing_key"
  | "unreadable_key"
  | "key_encryption_unconfigured"
  | "rejected_key"
  | "no_credit"
  | "spend_limit"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "cut_off"
  | "empty_reply"
  | "network"
  | "too_many_messages"
  | "message_too_long"
  | "conversation_too_long"
  | "invalid_conversation"
  | "notebook_not_found"
  | "save_failed";

export interface RefineWords {
  error: string;
  code: string;
}

type PerProvider = Record<RefineProvider, RefineWords>;

const same = (words: RefineWords): PerProvider => ({
  anthropic: words,
  openai: words,
});

const perLabel = (
  code: string,
  words: (label: string) => string,
): PerProvider => ({
  anthropic: { error: words(LLM_PROVIDERS.anthropic.label), code },
  openai: { error: words(LLM_PROVIDERS.openai.label), code },
});

// Copies of server-only constants (see the top of this file). Each is
// checked equal to its original by the unit test.
const KEY_ENCRYPTION_UNCONFIGURED_CODE = "key_encryption_unconfigured";

// The words, one table. Anthropic's no-credit, spend-limit and rate-limit
// refusals are not told apart (as in /api/execute): they get the
// "provider_error" words.
export const REFINE_WORDS: Record<RefineCase, PerProvider> = {
  missing_key: {
    anthropic: {
      error: REFINE_MISSING_KEY_MESSAGE,
      code: REFINE_MISSING_KEY_CODE,
    },
    // New in D17b.
    openai: {
      error:
        "Refine with AI needs your OpenAI API key. Add it in Account → Keys, " +
        "then try again. Nothing was sent.",
      code: "missing_openai_key",
    },
  },
  unreadable_key: {
    anthropic: {
      error:
        "Your saved Anthropic API key could not be read. Open Account → Keys " +
        "and save it again.",
      code: "unreadable_anthropic_key",
    },
    openai: {
      error:
        "Your saved OpenAI API key could not be read. Open Account → Keys " +
        "and save it again.",
      code: "unreadable_openai_key",
    },
  },
  key_encryption_unconfigured: {
    anthropic: {
      error:
        "This server is not configured to read saved API keys, so the run did " +
        "not start. Nothing was sent to Anthropic. Please contact support.",
      code: KEY_ENCRYPTION_UNCONFIGURED_CODE,
    },
    openai: {
      error:
        "This server is not configured to read saved API keys, so the run did " +
        "not start. Nothing was sent to OpenAI. Please contact support.",
      code: KEY_ENCRYPTION_UNCONFIGURED_CODE,
    },
  },
  rejected_key: {
    anthropic: {
      error: "Anthropic rejected your API key. Check it in Account → Keys.",
      code: "anthropic_rejected_key",
    },
    openai: {
      error: "OpenAI rejected your API key. Check it in Account → Keys.",
      code: "openai_rejected_key",
    },
  },
  no_credit: {
    anthropic: providerErrorWords("anthropic"),
    openai: {
      error:
        "Your OpenAI account has no API credit left. Add credit on OpenAI's " +
        "billing page (platform.openai.com), then run again.",
      code: "openai_no_credit",
    },
  },
  spend_limit: {
    anthropic: providerErrorWords("anthropic"),
    openai: {
      error:
        "Your OpenAI account has reached a spending or usage limit. Raise it " +
        "under Limits in your OpenAI settings (platform.openai.com), then run " +
        "again.",
      code: "openai_spend_limit",
    },
  },
  rate_limited: {
    anthropic: providerErrorWords("anthropic"),
    openai: {
      error:
        "OpenAI is limiting requests on your key right now. Wait a minute, " +
        "then run again.",
      code: "openai_rate_limited",
    },
  },
  provider_error: {
    anthropic: providerErrorWords("anthropic"),
    openai: providerErrorWords("openai"),
  },
  timeout: perLabel(
    "refine_timeout",
    (label) =>
      `${label} did not answer within ${REFINE_TIMEOUT_MS / 1000} seconds. ` +
      "Please try again.",
  ),
  cut_off: same({
    error: "The reply was cut off before it was finished. Please try again.",
    code: "refine_cut_off",
  }),
  empty_reply: perLabel(
    "refine_empty_reply",
    (label) => `${label} returned nothing. Please try again.`,
  ),
  network: same({
    error: "Couldn't reach pact-web. Please try again.",
    code: "refine_network",
  }),
  too_many_messages: same({
    error:
      `This conversation is at its limit of ${REFINE_MAX_MESSAGES} messages. ` +
      "Use the prompt you have, or start over.",
    code: "refine_too_many_messages",
  }),
  message_too_long: same({
    error:
      "That message is too long — " +
      `${REFINE_MAX_USER_CHARS.toLocaleString("en-US")} characters at most.`,
    code: "refine_message_too_long",
  }),
  // New in D17b: the D17a table had no words for these two.
  conversation_too_long: same({
    error:
      "This conversation is too long to continue. Use the prompt you have, " +
      "or start over.",
    code: "refine_conversation_too_long",
  }),
  invalid_conversation: same({
    error: "This conversation could not be read. Please start over.",
    code: "refine_invalid_conversation",
  }),
  notebook_not_found: same({
    error: "This notebook no longer exists.",
    code: "refine_notebook_not_found",
  }),
  // New in D17d: the reply arrived but storing the conversation failed.
  // The reply is still shown; this says it will not be there next time.
  save_failed: same({
    error:
      "This reply could not be saved. It is shown here, but it will be " +
      "gone when you close this dialog.",
    code: "refine_save_failed",
  }),
};

function providerErrorWords(provider: RefineProvider): RefineWords {
  return {
    error: `Couldn't get a reply from ${LLM_PROVIDERS[provider].label}. Please try again.`,
    code: "refine_provider_error",
  };
}

// OpenAI's refusals are shown with OpenAI's own short reason, as
// /api/execute shows them: "... then run again. (OpenAI: insufficient_quota)".
const REASON_LABEL: Record<RefineProvider, string | null> = {
  anthropic: null,
  openai: "OpenAI",
};
const WITH_REASON = new Set<RefineCase>([
  "no_credit",
  "spend_limit",
  "rate_limited",
]);

// The words for one case and provider. providerCode is the service's
// short reason (ProviderRequestError.providerCode), added only where
// /api/execute adds it.
export function refineWords(
  refineCase: RefineCase,
  provider: RefineProvider,
  providerCode?: string | null,
): RefineWords {
  const words = REFINE_WORDS[refineCase][provider];
  const label = REASON_LABEL[provider];
  if (label && providerCode && WITH_REASON.has(refineCase)) {
    return { ...words, error: `${words.error} (${label}: ${providerCode})` };
  }
  return words;
}

// The words for a refused conversation. Anything the browser should never
// send (a broken shape) gets the "start over" words.
export function refineCaseForProblem(problem: ConversationProblem): RefineCase {
  switch (problem) {
    case "too_many_messages":
      return "too_many_messages";
    case "user_message_too_long":
      return "message_too_long";
    case "assistant_message_too_long":
    case "total_too_long":
      return "conversation_too_long";
    default:
      return "invalid_conversation";
  }
}

// Shown under a reply that began a prompt and did not finish it.
export const REFINE_INCOMPLETE_NOTE =
  "This reply has an unfinished prompt (the end marker is missing). Ask for it again.";
