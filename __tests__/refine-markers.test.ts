import { describe, expect, test } from "vitest";
import {
  extractPrompt,
  latestPrompt,
  PROMPT_END_MARKER as END,
  PROMPT_START_MARKER as START,
  replySegments,
  type ReplySegment,
} from "@/lib/refineConversation";

// Task D17g. The one tolerated slip: a reply with no end-marker line and
// exactly two start-marker lines is one complete prompt. Every other case
// keeps the D17b rules. extractPrompt (the button and the incomplete
// note) and replySegments (the boxes) must always agree.

const boxes = (reply: string) =>
  replySegments(reply)
    .filter((s) => s.kind === "prompt")
    .map((s) => s.text);

// The box "Use this prompt" sits under is the last one.
function expectAgree(reply: string) {
  expect(boxes(reply).at(-1) ?? null).toBe(extractPrompt(reply).prompt);
}

// Nik's Preview trial, in shape: a question first, the prompt between two
// start lines (with bold words and blank lines in it), the refine
// question after.
const NIK_PROMPT =
  "You are assisting a doctoral researcher in **marine ecology** who studies coral reef recovery.\n\n" +
  "Be cautious and critical. Cite primary sources, and say plainly when evidence is thin.";
const NIK_REPLY =
  "Thank you, that covers your stance. Is there anything else you want the assistant to know?\n\n" +
  "Here is the system prompt:\n\n" +
  `${START}\n${NIK_PROMPT}\n${START}\n\n` +
  "Would you like to refine this further?";

describe("the doubled start marker (tolerated)", () => {
  test("Nik's case: a complete prompt, not unfinished", () => {
    expect(extractPrompt(NIK_REPLY)).toEqual({
      prompt: NIK_PROMPT,
      incomplete: false,
    });
  });

  test("Nik's case: the text, the prompt in its own box, the question", () => {
    expect(replySegments(NIK_REPLY)).toEqual<ReplySegment[]>([
      {
        kind: "text",
        text:
          "Thank you, that covers your stance. Is there anything else you want the assistant to know?\n\n" +
          "Here is the system prompt:",
      },
      { kind: "prompt", text: NIK_PROMPT },
      { kind: "text", text: "Would you like to refine this further?" },
    ]);
    expectAgree(NIK_REPLY);
  });

  test("Nik's case: Use this prompt takes it from the conversation", () => {
    expect(
      latestPrompt([
        { role: "user", content: "Coral reefs." },
        { role: "assistant", content: NIK_REPLY, provider: "anthropic" },
      ]),
    ).toEqual({ prompt: NIK_PROMPT, index: 1 });
  });

  test("spaces around the marker lines, CRLF line ends, and blank lines inside are trimmed", () => {
    const reply = `Here:\r\n  ${START}  \r\n\r\nYou are careful.\r\nCite sources.\r\n\r\n${START}\t\r\nMore?`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "You are careful.\nCite sources.",
      incomplete: false,
    });
    expect(boxes(reply)).toEqual(["You are careful.\nCite sources."]);
    expectAgree(reply);
  });

  test("nothing before or after the two lines", () => {
    const reply = `${START}\nYou are careful.\n${START}`;
    expect(replySegments(reply)).toEqual([
      { kind: "prompt", text: "You are careful." },
    ]);
    expect(extractPrompt(reply)).toEqual({
      prompt: "You are careful.",
      incomplete: false,
    });
  });
});

describe("unchanged from D17b", () => {
  test("one start and no end: unfinished, no prompt, shown as plain text with the marker", () => {
    const reply = `Here:\n${START}\nYou are`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: true });
    expect(replySegments(reply)).toEqual([{ kind: "text", text: reply }]);
  });

  test("three start markers and no end: unfinished, no prompt", () => {
    const reply = `${START}\nOne.\n${START}\nTwo.\n${START}\nThree.`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: true });
    expect(boxes(reply)).toEqual([]);
  });

  test("two start markers with only blank space between: no prompt, unfinished", () => {
    const reply = `Here:\n${START}\n\n  \n${START}\nYou are careful.`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: true });
    expect(boxes(reply)).toEqual([]);
  });

  test("a real end marker wins: two starts and an end read as D17b reads them (the second start restarts)", () => {
    const reply = `${START}\nDraft.\n${START}\nYou are careful.\n${END}\nMore?`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "You are careful.",
      incomplete: false,
    });
    expect(boxes(reply)).toEqual(["You are careful."]);
    expectAgree(reply);
  });

  test("a real end marker wins: a complete pair, then two starts, is the pair and unfinished", () => {
    const reply = `${START}\nFirst.\n${END}\n${START}\nSecond.\n${START}\nThird.`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "First.",
      incomplete: true,
    });
    expect(boxes(reply)).toEqual(["First."]);
  });

  test("the last complete pair wins", () => {
    const reply = `${START}\nFirst.\n${END}\nThen:\n${START}\nSecond.\n${END}`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "Second.",
      incomplete: false,
    });
    expect(boxes(reply)).toEqual(["First.", "Second."]);
    expectAgree(reply);
  });

  test("an end marker without a start is no prompt and not unfinished", () => {
    const reply = `You are careful.\n${END}\nMore?`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: false });
    expect(boxes(reply)).toEqual([]);
  });

  test("markers that are not alone on their line (bold, quoted, in a sentence) are not markers", () => {
    const reply = `**${START}**\nYou are careful.\n"${START}"\nI used ${START} twice.`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: false });
    expect(boxes(reply)).toEqual([]);
  });
});
