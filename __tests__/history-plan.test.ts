import { describe, expect, test } from "vitest";
import {
  parseContextChoice,
  planHistory,
  roughNumber,
  shouldShowHint,
  sizeWord,
  type PlanTurn,
} from "@/lib/historyPlan";
import { IMAGE_TOKENS, turnTokens } from "@/lib/historyBudget";
import { contextSummary, type PlanSummary } from "@/app/contextSummary";

// Task 71 Stage 2. The one plan both the hint and the run use.

function turn(id: string, pictures = 0, size = 10): PlanTurn {
  return {
    id,
    prompt_text: `prompt ${id} ` + "x".repeat(size),
    prompt_content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: `prompt ${id}` }],
        },
        ...Array.from({ length: pictures }, (_, i) => ({
          type: "image",
          attrs: { src: `/api/prompt-images/u/d/${id}-${i}.png` },
        })),
      ],
    },
    response: `answer ${id}`,
  };
}

const base = {
  model: "claude-sonnet-5",
  maxTokens: 40_000,
  systemPrompt: null,
  currentPrompt: [{ type: "text" as const, text: "question" }],
};

describe("planHistory", () => {
  test("with no choice, every completed turn and picture goes, as before", () => {
    const turns = [turn("a", 1), turn("b"), turn("c", 2)];
    const plan = planHistory({ ...base, turns });
    expect(plan.kept.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(plan).toMatchObject({
      totalTurns: 3,
      leftOutByChoice: 0,
      leftOutByCap: 0,
      picturesInHistory: 3,
      picturesSent: 3,
    });
  });

  test("a choice of turns keeps only those, in their original order", () => {
    const turns = [turn("a"), turn("b"), turn("c"), turn("d")];
    const plan = planHistory({
      ...base,
      turns,
      choice: { turnIds: ["d", "b"] },
    });
    expect(plan.kept.map((t) => t.id)).toEqual(["b", "d"]);
    expect(plan.leftOutByChoice).toBe(2);
  });

  test("leaving a turn's pictures out removes them from the count and the size", () => {
    const turns = [turn("a", 1), turn("b", 1), turn("c", 1)];
    const all = planHistory({ ...base, turns });
    const without = planHistory({
      ...base,
      turns,
      choice: { picturesOff: ["b"] },
    });
    expect(without.picturesSent).toBe(2);
    expect(without.kept).toHaveLength(3);
    expect(all.estimatedTokens - without.estimatedTokens).toBe(IMAGE_TOKENS);
  });

  test("the size cap still applies to the chosen turns: the oldest chosen go first", () => {
    const turns = [
      turn("a", 0, 3_000),
      turn("b", 0, 3_000),
      turn("c", 0, 3_000),
    ];
    const plan = planHistory({
      ...base,
      turns,
      choice: { turnIds: ["a", "b", "c"] },
      budgetOverride: turnTokens(turns[2]) + turnTokens(turns[1]) + 1,
    });
    expect(plan.kept.map((t) => t.id)).toEqual(["b", "c"]);
    expect(plan.leftOutByCap).toBe(1);
  });

  test("turns that never finished are neither offered nor counted", () => {
    const unfinished = { ...turn("x"), response: "" };
    const plan = planHistory({ ...base, turns: [unfinished, turn("a")] });
    expect(plan.totalTurns).toBe(1);
    expect(plan.kept.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("parseContextChoice", () => {
  test("absent is 'all'; a valid choice passes; anything else is refused", () => {
    expect(parseContextChoice(undefined)).toBeUndefined();
    expect(parseContextChoice({ turnIds: ["a"], picturesOff: [] })).toEqual({
      turnIds: ["a"],
      picturesOff: [],
    });
    expect(parseContextChoice({ picturesOff: ["b"] })).toEqual({
      picturesOff: ["b"],
    });
    expect(parseContextChoice("all")).toBeNull();
    expect(parseContextChoice({ turnIds: [1] })).toBeNull();
    expect(parseContextChoice({ turnIds: "a" })).toBeNull();
  });
});

describe("the size words and the hint", () => {
  test("a word and a rough number", () => {
    expect(sizeWord(3_000)).toBe("Small");
    expect(sizeWord(40_000)).toBe("Medium");
    expect(sizeWord(90_000)).toBe("Large");
    expect(sizeWord(150_000)).toBe("Very large");
    expect(roughNumber(39_620)).toBe("40,000");
    expect(roughNumber(640)).toBe("600");
    expect(roughNumber(12)).toBe("100");
  });

  test("short text-only discussions show no hint; pictures, length or a choice do", () => {
    const quiet = {
      picturesInHistory: 0,
      totalTurns: 4,
      estimatedTokens: 2_000,
      leftOutByCap: 0,
    };
    expect(shouldShowHint(quiet, false)).toBe(false);
    expect(shouldShowHint({ ...quiet, picturesInHistory: 1 }, false)).toBe(
      true,
    );
    expect(shouldShowHint({ ...quiet, totalTurns: 10 }, false)).toBe(true);
    expect(shouldShowHint({ ...quiet, estimatedTokens: 20_000 }, false)).toBe(
      true,
    );
    expect(shouldShowHint({ ...quiet, leftOutByCap: 1 }, false)).toBe(true);
    expect(shouldShowHint(quiet, true)).toBe(true);
  });

  const summary = (over: Partial<PlanSummary>): PlanSummary => ({
    totalTurns: 6,
    turnsSent: 6,
    turnIdsSent: [],
    leftOutByChoice: 0,
    leftOutByCap: 0,
    picturesInHistory: 3,
    picturesSent: 3,
    estimatedTokens: 40_000,
    sizeWord: "Medium",
    roughSize: "40,000",
    showHint: true,
    ...over,
  });

  test("the line reads plainly", () => {
    expect(contextSummary(summary({}))).toBe(
      "With this question: 6 earlier turns · 3 pictures · size: Medium (about 40,000)",
    );
    expect(contextSummary(summary({ turnsSent: 1, picturesSent: 1 }))).toBe(
      "With this question: 1 of 6 earlier turns · 1 of 3 pictures · size: Medium (about 40,000)",
    );
    expect(
      contextSummary(
        summary({ turnsSent: 0, picturesSent: 0, picturesInHistory: 0 }),
      ),
    ).toBe(
      "With this question: no earlier turns · size: Medium (about 40,000)",
    );
    expect(contextSummary(summary({ turnsSent: 4, leftOutByCap: 2 }))).toBe(
      "With this question: 4 of 6 earlier turns · 3 pictures · size: Medium (about 40,000) · the 2 oldest turns are left out to fit the size limit",
    );
  });
});
