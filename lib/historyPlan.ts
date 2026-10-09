import { docToContentSegments } from "./promptContentToMarkdownBlocks";
import type { RichContent } from "./richContent";
import {
  contentBlocksTokens,
  countDocImages,
  estimateTextTokens,
  historyTokenBudget,
  IMAGE_TOKENS,
  turnTokens,
} from "./historyBudget";
import { MAX_IMAGES_PER_REQUEST } from "./discussionHistory";
import type { AnthropicContentBlock } from "./promptContentToAnthropicBlocks";

// Task 71 Stage 2. Which earlier turns, and which of their pictures, go
// with one question -- decided in ONE place. The run (app/api/execute)
// builds its request from this plan, and the hint under the prompt box
// (app/api/history-plan) shows the same plan, so the two cannot disagree.
//
// Order: the user's choice for this one question first (which turns, and
// which turns' pictures to leave out), then Stage 1's cap on what is left
// (the oldest whole turns that do not fit the model's window). Nothing
// here deletes anything; it only shapes one request.

// When an older max_tokens setting cannot be read (same fallback the run
// has always used).
export const FALLBACK_MAX_TOKENS = 1000;

// The user's choice for the next question. Absent fields mean "all":
// no turnIds sends every earlier turn, no picturesOff keeps every picture.
export interface ContextChoice {
  turnIds?: string[];
  picturesOff?: string[];
}

const MAX_IDS = 1000;

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IDS &&
    value.every((v) => typeof v === "string" && v.length > 0 && v.length < 100)
  );
}

// Undefined when nothing was chosen; null when what arrived is not a
// valid choice (the caller answers 400).
export function parseContextChoice(
  raw: unknown,
): ContextChoice | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const { turnIds, picturesOff } = raw as Record<string, unknown>;
  if (turnIds !== undefined && !isIdList(turnIds)) return null;
  if (picturesOff !== undefined && !isIdList(picturesOff)) return null;
  return {
    ...(turnIds !== undefined ? { turnIds } : {}),
    ...(picturesOff !== undefined ? { picturesOff } : {}),
  };
}

export interface PlanTurn {
  id: string;
  prompt_text: string | null;
  prompt_content: RichContent | null;
  response: string | null;
}

export interface HistoryPlan<T extends PlanTurn = PlanTurn> {
  // The turns to send, oldest first, after the choice and the cap.
  kept: T[];
  // Turns whose pictures are left out by choice.
  picturesOff: Set<string>;
  // Every completed earlier turn in the discussion.
  totalTurns: number;
  leftOutByChoice: number;
  leftOutByCap: number;
  picturesInHistory: number;
  picturesSent: number;
  // The whole request: system prompt, earlier turns, this question.
  estimatedTokens: number;
  budget: number;
}

// The current question's estimated tokens, from its rich content -- the
// same arithmetic as contentBlocksTokens over the blocks the run sends
// (text segments counted as text, each picture 1,600), without fetching
// any picture.
export function promptDocBlocksForEstimate(
  content: RichContent | null,
): AnthropicContentBlock[] {
  if (!content) return [];
  return docToContentSegments(content).map((segment) =>
    segment.type === "text"
      ? { type: "text" as const, text: segment.text }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "", data: "" },
        },
  );
}

export function isComplete(turn: PlanTurn): boolean {
  return (
    (turn.prompt_text ?? "").trim().length > 0 &&
    (turn.response ?? "").trim().length > 0
  );
}

export function planHistory<T extends PlanTurn>(args: {
  turns: T[];
  choice?: ContextChoice;
  model: string;
  maxTokens: number;
  systemPrompt: string | null;
  currentPrompt: AnthropicContentBlock[];
  // The run's one retry (Stage 1) passes a smaller budget.
  budgetOverride?: number;
}): HistoryPlan<T> {
  const complete = args.turns.filter(isComplete);
  const chosenIds = args.choice?.turnIds ? new Set(args.choice.turnIds) : null;
  const chosen = chosenIds
    ? complete.filter((t) => chosenIds.has(t.id))
    : complete;
  const picturesOff = new Set(args.choice?.picturesOff ?? []);

  const budget =
    args.budgetOverride ??
    historyTokenBudget({
      model: args.model,
      maxTokens: args.maxTokens,
      systemPrompt: args.systemPrompt,
      currentPrompt: args.currentPrompt,
    });

  // Stage 1's rule on the chosen turns: the newest whole turns that fit,
  // a turn whose pictures are left out costing only its text.
  const cost = (t: T) =>
    turnTokens(t) -
    (picturesOff.has(t.id)
      ? countDocImages(t.prompt_content) * IMAGE_TOKENS
      : 0);
  let used = 0;
  let start = chosen.length;
  for (let i = chosen.length - 1; i >= 0; i--) {
    if (used + cost(chosen[i]) > budget) break;
    used += cost(chosen[i]);
    start = i;
  }
  const kept = chosen.slice(start);

  // Pictures actually sent, within Task 69's per-request count limit
  // after the current question's own pictures.
  const currentPictures = args.currentPrompt.filter(
    (b) => b.type === "image",
  ).length;
  const keptPictures = kept.reduce(
    (n, t) =>
      n + (picturesOff.has(t.id) ? 0 : countDocImages(t.prompt_content)),
    0,
  );
  const picturesSent = Math.max(
    0,
    Math.min(keptPictures, MAX_IMAGES_PER_REQUEST - currentPictures),
  );

  return {
    kept,
    picturesOff,
    totalTurns: complete.length,
    leftOutByChoice: complete.length - chosen.length,
    leftOutByCap: start,
    picturesInHistory: complete.reduce(
      (n, t) => n + countDocImages(t.prompt_content),
      0,
    ),
    picturesSent,
    estimatedTokens:
      estimateTextTokens(args.systemPrompt) +
      used +
      contentBlocksTokens(args.currentPrompt),
    budget,
  };
}

// "Small", "Medium", ... and a rough number, for the hint.
export function sizeWord(tokens: number): string {
  if (tokens < 10_000) return "Small";
  if (tokens < 50_000) return "Medium";
  if (tokens < 120_000) return "Large";
  return "Very large";
}

export function roughNumber(tokens: number): string {
  const step = tokens >= 1_000 ? 1_000 : 100;
  const rounded = Math.max(step, Math.round(tokens / step) * step);
  return rounded.toLocaleString("en-US");
}

// Short, text-only discussions stay exactly as they were: no hint line
// unless there is something worth knowing.
export function shouldShowHint(
  plan: Pick<
    HistoryPlan,
    "picturesInHistory" | "totalTurns" | "estimatedTokens" | "leftOutByCap"
  >,
  choiceActive: boolean,
): boolean {
  return (
    choiceActive ||
    plan.picturesInHistory > 0 ||
    plan.totalTurns >= 10 ||
    plan.estimatedTokens >= 20_000 ||
    plan.leftOutByCap > 0
  );
}
