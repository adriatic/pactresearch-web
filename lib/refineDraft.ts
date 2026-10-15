// Task 98. Reads the draft out of /api/refine-system-prompt's Anthropic
// reply. Kept apart from the route so the cut-off case can be tested
// without a key.
//
// On claude-sonnet-5 (the Standard tier) a request that sets no `thinking`
// runs adaptive thinking, and max_tokens caps thinking and the answer
// together. So a reply can end at the cap part-way through the draft, or
// with thinking only and no text at all. Only `text` blocks are the draft;
// `thinking` blocks (empty text by default) are skipped.

export type AnthropicDraftMessage = {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
};

export const DRAFT_CUT_OFF_MESSAGE =
  "The draft was cut off before it was finished. Please try again.";

export const DRAFT_EMPTY_MESSAGE =
  "The model returned nothing. Please try again.";

export function draftFromMessage(
  message: AnthropicDraftMessage,
): { systemPrompt: string } | { error: string } {
  // Checked before the text: a cut-off draft must not reach the field
  // looking finished.
  if (message.stop_reason === "max_tokens") {
    return { error: DRAFT_CUT_OFF_MESSAGE };
  }
  const systemPrompt = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  if (!systemPrompt) {
    return { error: DRAFT_EMPTY_MESSAGE };
  }
  return { systemPrompt };
}

// Task 98. The missing-key reply as the New Notebook dialog shows it.
// The route answers a missing key with MISSING_KEY_MESSAGE ("... before
// running prompts"), which Settings shows unchanged; this wording is for
// Refine. The code is the route's MISSING_KEY_CODE, repeated here because
// lib/userAnthropicKey.ts is server-only (it decrypts) and must not reach
// a client bundle; __tests__/refine-draft.test.ts keeps the two equal.
export const REFINE_MISSING_KEY_CODE = "missing_anthropic_key";

export const REFINE_MISSING_KEY_MESSAGE =
  "Refine with AI needs your Anthropic API key. Add it in Account → Keys, " +
  "then try again. Nothing was sent.";
