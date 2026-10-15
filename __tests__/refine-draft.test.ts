import { describe, expect, test } from "vitest";
import {
  DRAFT_CUT_OFF_MESSAGE,
  DRAFT_EMPTY_MESSAGE,
  REFINE_MISSING_KEY_CODE,
  draftFromMessage,
} from "@/lib/refineDraft";
import { MISSING_KEY_CODE } from "@/lib/userAnthropicKey";

// Task 98. The shapes a claude-sonnet-5 reply can take with adaptive
// thinking on by default: thinking blocks (empty text) before the draft,
// and a stop at max_tokens part-way through.
describe("draftFromMessage", () => {
  test("a finished draft after a thinking block is returned, thinking skipped", () => {
    expect(
      draftFromMessage({
        content: [
          { type: "thinking", text: "" },
          { type: "text", text: "  You are an oncology reviewer.  " },
        ],
        stop_reason: "end_turn",
      }),
    ).toEqual({ systemPrompt: "You are an oncology reviewer." });
  });

  test("a draft cut off at max_tokens is an error, not a draft", () => {
    expect(
      draftFromMessage({
        content: [
          { type: "thinking", text: "" },
          { type: "text", text: "You are an oncology reviewer. Flag any" },
        ],
        stop_reason: "max_tokens",
      }),
    ).toEqual({ error: DRAFT_CUT_OFF_MESSAGE });
  });

  test("thinking that used the whole cap, with no text, is the cut-off error", () => {
    expect(
      draftFromMessage({
        content: [{ type: "thinking", text: "" }],
        stop_reason: "max_tokens",
      }),
    ).toEqual({ error: DRAFT_CUT_OFF_MESSAGE });
  });

  test("a finished reply with no text is the empty error", () => {
    expect(draftFromMessage({ content: [], stop_reason: "end_turn" })).toEqual({
      error: DRAFT_EMPTY_MESSAGE,
    });
  });
});

test("the dialog's missing-key code is the route's", () => {
  expect(REFINE_MISSING_KEY_CODE).toBe(MISSING_KEY_CODE);
});
