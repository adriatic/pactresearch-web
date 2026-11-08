import { describe, expect, test } from "vitest";
import {
  extractPrompt,
  PROMPT_END_MARKER as END,
  PROMPT_START_MARKER as START,
  REFINE_MAX_MESSAGES,
  refineAtLimit,
  replySegments,
  type RefineMessage,
} from "@/lib/refineConversation";

// Task D17e. The pure parts the dialog draws with: a reply cut into text
// and boxed prompts, and the 40-message limit.

const lastPrompt = (reply: string) =>
  replySegments(reply)
    .filter((s) => s.kind === "prompt")
    .at(-1)?.text ?? null;

describe("replySegments", () => {
  test("a plain question is one text piece", () => {
    expect(replySegments("What is your field?")).toEqual([
      { kind: "text", text: "What is your field?" },
    ]);
  });

  test("a marked prompt is boxed, without its marker lines, between its text", () => {
    const reply = `Here it is:\n${START}\nYou are a careful historian.\nCite sources.\n${END}\nShall I refine it?`;
    expect(replySegments(reply)).toEqual([
      { kind: "text", text: "Here it is:" },
      {
        kind: "prompt",
        text: "You are a careful historian.\nCite sources.",
      },
      { kind: "text", text: "Shall I refine it?" },
    ]);
  });

  test("the last box is exactly what extractPrompt (Use this prompt) copies", () => {
    const replies = [
      `${START}\n  one  \n${END}`,
      `a\n${START}\nfirst\n${END}\nb\n${START}\nsecond\n${END}\nc`,
      `  ${START}\t\nindented markers\n\t${END}  `,
      `${START}\nfirst\n${START}\nrestarted\n${END}`,
      `x\r\n${START}\r\nwindows lines\r\n${END}\r\ny`,
      `${START}\ncomplete\n${END}\n${START}\nunfinished`,
    ];
    for (const reply of replies) {
      expect(lastPrompt(reply)).toBe(extractPrompt(reply).prompt);
    }
  });

  test("an unfinished prompt stays text, start marker included", () => {
    const reply = `Here:\n${START}\nYou are`;
    expect(replySegments(reply)).toEqual([
      { kind: "text", text: `Here:\n${START}\nYou are` },
    ]);
  });

  test("a blank pair, a lone END and markers inside a sentence stay text", () => {
    expect(replySegments(`${START}\n  \n${END}`)).toEqual([
      { kind: "text", text: `${START}\n  \n${END}` },
    ]);
    expect(replySegments(`text\n${END}`)).toEqual([
      { kind: "text", text: `text\n${END}` },
    ]);
    const sentence = `I will put it between ${START} and ${END}.`;
    expect(replySegments(sentence)).toEqual([{ kind: "text", text: sentence }]);
  });

  test("a restarted prompt keeps the abandoned start as text", () => {
    expect(replySegments(`${START}\nfirst\n${START}\nsecond\n${END}`)).toEqual([
      { kind: "text", text: `${START}\nfirst` },
      { kind: "prompt", text: "second" },
    ]);
  });

  test("nothing the model wrote is lost: every non-marker line appears once", () => {
    const reply = `a\n${START}\nb\n${END}\nc\n${START}\nd`;
    const shown = replySegments(reply)
      .map((s) => s.text)
      .join("\n");
    for (const word of ["a", "b", "c", "d"]) {
      expect(shown.split("\n").filter((l) => l === word)).toHaveLength(1);
    }
  });
});

describe("refineAtLimit", () => {
  const conversation = (n: number): RefineMessage[] =>
    Array.from({ length: n }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `q${i}` }
        : { role: "assistant", content: `a${i}`, provider: "anthropic" },
    );

  test("38 messages can take one more turn (39 sent, 40 stored)", () => {
    expect(refineAtLimit(conversation(REFINE_MAX_MESSAGES - 2))).toBe(false);
  });

  test("39 and 40 messages are at the limit", () => {
    expect(refineAtLimit(conversation(REFINE_MAX_MESSAGES - 1))).toBe(true);
    expect(refineAtLimit(conversation(REFINE_MAX_MESSAGES))).toBe(true);
  });

  test("an empty conversation is not", () => {
    expect(refineAtLimit([])).toBe(false);
  });
});
