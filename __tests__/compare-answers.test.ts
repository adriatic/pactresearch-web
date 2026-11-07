import { describe, expect, it } from "vitest";
import {
  answerOptionText,
  compareHref,
  ENGINE_TEXT_LIMITS,
  findAnswer,
  groupAnswers,
  groupHeading,
  isResponseId,
  parseCompareParams,
  tooLongMessage,
  type AnswerRow,
  type DiscussionRow,
  type NotebookRow,
} from "@/lib/diff/compareAnswers";

// Task D13. The Compare page's helpers: grouping and numbering the
// answers for the pickers, the label, the address, and the length caps.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const notebooks: NotebookRow[] = [
  { id: "nb-old", name: "Research", created_at: "2026-10-01T09:00:00Z" },
  { id: "nb-new", name: "Drafts", created_at: "2026-11-01T09:00:00Z" },
  { id: "nb-empty", name: "Empty", created_at: "2026-11-02T09:00:00Z" },
];
const discussions: DiscussionRow[] = [
  {
    id: "d-second",
    name: "Article 3 round 2",
    notebook_id: "nb-old",
    created_at: "2026-10-03T09:00:00Z",
  },
  {
    id: "d-first",
    name: "Article 3 round 1",
    notebook_id: "nb-old",
    created_at: "2026-10-02T09:00:00Z",
  },
  {
    id: "d-drafts",
    name: "Outline",
    notebook_id: "nb-new",
    created_at: "2026-11-01T10:00:00Z",
  },
  {
    id: "d-no-answers",
    name: "Nothing yet",
    notebook_id: "nb-new",
    created_at: "2026-11-01T11:00:00Z",
  },
];
const row = (
  n: number,
  discussion: string,
  at: string,
  model: string | null = "claude-sonnet-5",
  resolved: string | null = null,
): AnswerRow => ({
  id: id(n),
  discussion_id: discussion,
  created_at: at,
  model,
  resolved_model: resolved,
});
const answers: AnswerRow[] = [
  // Given out of order on purpose: numbering follows created_at.
  row(4, "d-first", "2026-10-02T09:04:00Z", "gpt-6.1-sol"),
  row(1, "d-first", "2026-10-02T09:01:00Z"),
  row(
    3,
    "d-first",
    "2026-10-02T09:03:00Z",
    "claude-sonnet-5",
    "claude-sonnet-5-20261001",
  ),
  row(2, "d-first", "2026-10-02T09:02:00Z"),
  row(5, "d-second", "2026-10-03T09:01:00Z"),
  row(6, "d-drafts", "2026-11-01T10:01:00Z", "claude"),
];

describe("groupAnswers", () => {
  const groups = groupAnswers(notebooks, discussions, answers);

  it("lists notebooks newest first, discussions oldest first, and leaves out discussions with no answers", () => {
    expect(groups.map(groupHeading)).toEqual([
      "Drafts › Outline",
      "Research › Article 3 round 1",
      "Research › Article 3 round 2",
    ]);
  });

  it("numbers each discussion's answers in the order they were made", () => {
    const first = groups[1];
    expect(first.answers.map((a) => [a.number, a.id])).toEqual([
      [1, id(1)],
      [2, id(2)],
      [3, id(3)],
      [4, id(4)],
    ]);
    expect(groups[2].answers.map((a) => a.number)).toEqual([1]);
  });

  it("breaks a tie in time by id, so the numbering never changes between loads", () => {
    const same = "2026-10-02T09:00:00Z";
    const g = groupAnswers(notebooks, discussions, [
      row(9, "d-first", same),
      row(8, "d-first", same),
    ]);
    expect(g[0].answers.map((a) => a.id)).toEqual([id(8), id(9)]);
  });

  it("labels each answer the way the workspace does", () => {
    const first = groups[1];
    expect(first.answers.map((a) => a.label)).toEqual([
      "Claude · claude-sonnet-5",
      "Claude · claude-sonnet-5",
      "Claude · claude-sonnet-5-20261001",
      "ChatGPT · gpt-6.1-sol",
    ]);
    // A bare service word shows the service alone.
    expect(groups[0].answers[0].label).toBe("Claude");
  });

  it("findAnswer gives the group and the number, or null", () => {
    const place = findAnswer(groups, id(4));
    expect(place?.group.discussionName).toBe("Article 3 round 1");
    expect(place?.answer.number).toBe(4);
    expect(findAnswer(groups, id(99))).toBeNull();
  });

  it("no answers at all: an empty list", () => {
    expect(groupAnswers(notebooks, discussions, [])).toEqual([]);
  });
});

describe("answerOptionText", () => {
  it("reads 'answer N · model label · date'", () => {
    const [answer] = groupAnswers(notebooks, discussions, answers)[1].answers;
    expect(answerOptionText(answer, () => "2 Oct 2026, 09:01")).toBe(
      "answer 1 · Claude · claude-sonnet-5 · 2 Oct 2026, 09:01",
    );
    expect(answerOptionText(answer, () => "")).toBe(
      "answer 1 · Claude · claude-sonnet-5",
    );
  });
});

describe("the address", () => {
  it("reads a, b and the engine, falling back to Word diff", () => {
    expect(parseCompareParams({ a: id(1), b: id(2) })).toEqual({
      a: id(1),
      b: id(2),
      engine: "word",
    });
    expect(parseCompareParams({ a: id(1), engine: "json" })).toEqual({
      a: id(1),
      b: null,
      engine: "json",
    });
    // Task D15: "meaning" is an engine now; an unknown id falls back.
    expect(parseCompareParams({ engine: "meaning" }).engine).toBe("meaning");
    expect(parseCompareParams({ engine: "no-such-engine" }).engine).toBe(
      "word",
    );
    expect(parseCompareParams({ a: [id(1), id(2)], b: "  " })).toEqual({
      a: id(1),
      b: null,
      engine: "word",
    });
  });

  it("builds the address for a choice, without the default engine", () => {
    expect(compareHref({ a: id(1), b: id(2) })).toBe(
      `/compare?a=${id(1)}&b=${id(2)}`,
    );
    expect(compareHref({ a: id(1), b: id(2), engine: "word" })).toBe(
      `/compare?a=${id(1)}&b=${id(2)}`,
    );
    expect(compareHref({ a: null, b: id(2), engine: "line" })).toBe(
      `/compare?b=${id(2)}&engine=line`,
    );
    expect(compareHref({ a: null, b: null })).toBe("/compare");
  });

  it("only a well-formed id can be looked up", () => {
    expect(isResponseId(id(1))).toBe(true);
    expect(isResponseId("not-an-id")).toBe(false);
    expect(isResponseId("'; drop table responses; --")).toBe(false);
    expect(isResponseId(undefined)).toBe(false);
  });
});

describe("the length caps", () => {
  it("Character diff runs on up to 20,000 characters together", () => {
    expect(ENGINE_TEXT_LIMITS.character).toBe(20_000);
    expect(
      tooLongMessage("character", "x".repeat(10_000), "y".repeat(10_000)),
    ).toBeNull();
    const message = tooLongMessage(
      "character",
      "x".repeat(10_000),
      "y".repeat(10_001),
    );
    expect(message).toBe(
      "These two answers are too long for Character diff: 20,001 characters together, and Character diff runs on up to 20,000. Use Word diff or Line diff.",
    );
  });

  it("Word diff runs on up to 80,000 characters together", () => {
    expect(
      tooLongMessage("word", "x".repeat(40_000), "y".repeat(40_000)),
    ).toBeNull();
    expect(tooLongMessage("word", "x".repeat(40_000), "y".repeat(40_001))).toBe(
      "These two answers are too long for Word diff: 80,001 characters together, and Word diff runs on up to 80,000. Use Line diff.",
    );
  });

  it("Line, JSON and semantic have no cap", () => {
    const long = "x".repeat(500_000);
    for (const engine of ["line", "json", "semantic"]) {
      expect(tooLongMessage(engine, long, long), engine).toBeNull();
    }
  });
});
