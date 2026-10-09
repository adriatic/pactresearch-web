import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  estimateTextTokens,
  historyTokenBudget,
  IMAGE_TOKENS,
  newestTurnsWithinBudget,
  promptTooLongOvershoot,
  turnTokens,
  type BudgetTurn,
} from "@/lib/historyBudget";
import { historyToAnthropicMessages } from "@/lib/discussionHistory";
import { historyLeftOutNote } from "@/app/DiscussionContent";

// Task 71. The history cap: oldest whole turns are left out of the
// request until it fits, pictures counted.

const text = (prompt: string, response: string): BudgetTurn => ({
  prompt_text: prompt,
  prompt_content: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: prompt }] }],
  },
  response,
});

const pictures = (prompt: string, n: number, response: string): BudgetTurn => ({
  prompt_text: prompt,
  prompt_content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: prompt }] },
      ...Array.from({ length: n }, (_, i) => ({
        type: "image",
        attrs: { src: `/api/prompt-images/u/d/${prompt}-${i}.png` },
      })),
    ],
  },
  response,
});

describe("the estimate", () => {
  test("plain English counts about one token per three characters, rounding up", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
    expect(estimateTextTokens("abc")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(2);
    expect(estimateTextTokens("a".repeat(300))).toBe(100);
  });

  test("every character outside plain ASCII counts as a whole token, so other languages are not under-counted", () => {
    expect(estimateTextTokens("Ћирилица")).toBe(8);
    expect(estimateTextTokens("čćž")).toBe(3);
    expect(estimateTextTokens("ab čć")).toBe(1 + 2);
  });

  test("a picture counts 1,600 tokens, whatever its size", () => {
    expect(IMAGE_TOKENS).toBe(1_600);
    const withThree = turnTokens(pictures("p", 3, "r"));
    const withNone = turnTokens(pictures("p", 0, "r"));
    expect(withThree - withNone).toBe(3 * 1_600);
  });

  test("the budget is the window, less headroom, the answer's room, the system prompt and the current prompt", () => {
    const budget = historyTokenBudget({
      model: "claude-sonnet-5",
      maxTokens: 4_000,
      systemPrompt: "a".repeat(300),
      currentPrompt: [
        { type: "text", text: "a".repeat(30) },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "x" },
        },
      ],
    });
    // 200,000 x 0.9 - 4,000 - 100 - (8 + 10 + 1,600)
    expect(budget).toBe(180_000 - 4_000 - 100 - 1_618);
  });
});

describe("leaving out the oldest whole turns", () => {
  test("a short discussion keeps every turn", () => {
    const turns = [text("one", "1"), text("two", "2"), text("three", "3")];
    const r = newestTurnsWithinBudget(turns, 170_000);
    expect(r.kept).toEqual(turns);
    expect(r.leftOut).toBe(0);
  });

  test("when it does not fit, the oldest turns go first and the newest stay", () => {
    const turns = [1, 2, 3, 4, 5].map((n) =>
      text(`prompt ${n} `.repeat(30), `answer ${n} `.repeat(30)),
    );
    const each = turnTokens(turns[0]);
    const r = newestTurnsWithinBudget(turns, each * 2 + 1);
    expect(r.kept).toEqual([turns[3], turns[4]]);
    expect(r.leftOut).toBe(3);
  });

  test("never from the middle: a small older turn is not slipped in once a bigger one has not fitted", () => {
    const small = text("hi", "ok");
    const big = text("x".repeat(3_000), "y".repeat(3_000));
    const newest = text("latest", "fine");
    const budget = turnTokens(newest) + turnTokens(small) + 10;
    const r = newestTurnsWithinBudget([small, big, newest], budget);
    expect(r.kept).toEqual([newest]);
    expect(r.leftOut).toBe(2);
  });

  test("pictures fill the budget faster than their text suggests", () => {
    const turns = [
      pictures("a", 1, "ok"),
      pictures("b", 1, "ok"),
      pictures("c", 1, "ok"),
      pictures("d", 1, "ok"),
    ];
    // Room for two picture turns and change, but not three.
    const r = newestTurnsWithinBudget(turns, 2 * 1_650);
    expect(r.kept.map((t) => t.prompt_text)).toEqual(["c", "d"]);
    // The same four turns without pictures all fit.
    const plain = turns.map((t) => text(t.prompt_text!, t.response!));
    expect(newestTurnsWithinBudget(plain, 2 * 1_650).leftOut).toBe(0);
  });

  test("left-out turns' pictures are never fetched", async () => {
    const fetched: string[] = [];
    const supabase = {
      storage: {
        from: () => ({
          download: async (path: string) => {
            fetched.push(path);
            return { data: new Blob(["IMG"]), error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    const { messages, stats } = await historyToAnthropicMessages(
      [pictures("old", 2, "r1"), pictures("new", 1, "r2")],
      supabase,
      { count: 0, bytes: 0 },
      turnTokens(pictures("new", 1, "r2")),
    );
    expect(stats).toMatchObject({ turnsSent: 1, turnsLeftOut: 1 });
    expect(fetched).toEqual(["u/d/new-0.png"]);
    expect(messages).toHaveLength(2);
  });
});

describe("Anthropic's 'prompt is too long' refusal", () => {
  test("its overshoot is read from the message", () => {
    expect(
      promptTooLongOvershoot(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}',
      ),
    ).toBe(15_000);
  });

  test("without numbers it is still recognised", () => {
    expect(promptTooLongOvershoot(400, "Prompt is too long")).toBe(0);
  });

  test("any other error is not mistaken for it", () => {
    expect(promptTooLongOvershoot(400, "max_tokens: too large")).toBeNull();
    expect(promptTooLongOvershoot(429, "prompt is too long")).toBeNull();
  });
});

describe("the note under the answer", () => {
  test("is plain, and says the turns are still saved", () => {
    expect(historyLeftOutNote(1)).toBe(
      "To fit the model's size limit, this answer did not see the oldest turn of this discussion. It is still saved here and in exports.",
    );
    expect(historyLeftOutNote(4)).toBe(
      "To fit the model's size limit, this answer did not see the 4 oldest turns of this discussion. They are still saved here and in exports.",
    );
  });
});
