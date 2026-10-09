import type { AnthropicContentBlock } from "./promptContentToAnthropicBlocks";
import type { RichContent } from "./richContent";

// Task 71. How much of a discussion's history fits in one request.
//
// Since Task 62 every run sends the discussion's whole history, and since
// Task 69 every earlier picture too, so a long discussion would sooner or
// later exceed the model's context window and take a hard 400 on every
// run. Nik's decision: drop the OLDEST WHOLE TURNS until it fits. Never a
// turn from the middle, never part of a turn, and only from the request:
// stored history and every export keep everything.
//
// The size is ESTIMATED here, without a round trip to Anthropic's token
// counter (an extra request before every run). The estimate leans high
// on purpose, and the route keeps one retry for the case it is still
// too low (a "prompt is too long" 400 from Anthropic) -- see
// app/api/execute/route.ts.

// Both tiers' models (lib/modelTiers.ts) have a 200,000-token window;
// an unknown model is assumed to have the same.
export const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "claude-sonnet-5": 200_000,
  "claude-haiku-4-5": 200_000,
};
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// Kept free below the window: the estimate is an estimate, and the
// request carries JSON and role markers the estimate does not see.
export const HEADROOM_FRACTION = 0.1;

// Anthropic's figure for an image is about (width x height) / 750 tokens,
// and images are scaled down to at most about 1.15 megapixels first, so
// one image costs at most about 1,600 tokens. Every image is counted at
// that maximum, without fetching it to measure it.
export const IMAGE_TOKENS = 1_600;

// Per message, for the role and the wrapping around it.
const MESSAGE_OVERHEAD_TOKENS = 8;

// English runs about 4 characters to a token; this counts 3, and every
// character outside plain ASCII (accents, Cyrillic, Chinese) as a whole
// token, so text in any language is over- rather than under-counted.
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
}

export function contextWindowFor(model: string): number {
  return CONTEXT_WINDOW_TOKENS[model] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function countDocImages(content: RichContent | null): number {
  const nodes = content?.content;
  if (!Array.isArray(nodes)) return 0;
  return nodes.filter((node) => node?.type === "image").length;
}

export interface BudgetTurn {
  prompt_text: string | null;
  prompt_content: RichContent | null;
  response: string | null;
}

// One earlier turn: its prompt (text and pictures) and its answer.
export function turnTokens(turn: BudgetTurn): number {
  return (
    estimateTextTokens(turn.prompt_text) +
    countDocImages(turn.prompt_content) * IMAGE_TOKENS +
    estimateTextTokens(turn.response) +
    2 * MESSAGE_OVERHEAD_TOKENS
  );
}

export function contentBlocksTokens(blocks: AnthropicContentBlock[]): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const block of blocks) {
    total +=
      block.type === "image" ? IMAGE_TOKENS : estimateTextTokens(block.text);
  }
  return total;
}

// What is left for history once everything else in the request is paid
// for: the window, less headroom, less the room the answer may use
// (max_tokens), the system prompt and the current prompt.
export function historyTokenBudget(args: {
  model: string;
  maxTokens: number;
  systemPrompt: string | null;
  currentPrompt: AnthropicContentBlock[];
}): number {
  const window = contextWindowFor(args.model);
  return Math.max(
    0,
    Math.floor(window * (1 - HEADROOM_FRACTION)) -
      args.maxTokens -
      estimateTextTokens(args.systemPrompt) -
      contentBlocksTokens(args.currentPrompt),
  );
}

// The newest turns that fit, oldest first, as an unbroken run ending at
// the most recent turn. Whole turns only: the first one that does not
// fit ends the run, even if an older, smaller one would.
export function newestTurnsWithinBudget<T extends BudgetTurn>(
  turns: T[],
  budget: number,
): { kept: T[]; leftOut: number; estimatedTokens: number } {
  let used = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = turnTokens(turns[i]);
    if (used + cost > budget) break;
    used += cost;
    start = i;
  }
  return {
    kept: turns.slice(start),
    leftOut: start,
    estimatedTokens: used,
  };
}

// Anthropic's refusal when the estimate was still too low reads
// "prompt is too long: 215000 tokens > 200000 maximum". Returns the
// overshoot in tokens when it can be read, 0 when it is that error
// without numbers, and null when it is some other error.
export function promptTooLongOvershoot(
  status: number,
  body: string,
): number | null {
  if (status !== 400 || !/prompt is too long/i.test(body)) return null;
  const match = body.match(/(\d+)\s*tokens\s*>\s*(\d+)/);
  if (!match) return 0;
  return Math.max(0, Number(match[1]) - Number(match[2]));
}
