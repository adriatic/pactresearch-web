import { describe, expect, test } from "vitest";
import {
  extractFollowUpQuestion,
  followUpPlaceholder,
} from "@/lib/followUpQuestion";
import { isEmptyDoc } from "@/lib/richContent";

describe("extractFollowUpQuestion", () => {
  test("surfaces only the trailing question, not the sentence before it", () => {
    // The exact case that prompted task 49.
    expect(
      extractFollowUpQuestion(
        "You're doing the right thing by her. What's happening with her care needs?",
      ),
    ).toBe("What's happening with her care needs?");
  });

  test("uses the last line of a multi-paragraph response", () => {
    expect(
      extractFollowUpQuestion(
        "Here is a long answer.\n\nWith several paragraphs.\n\nWhat would you like to explore next?",
      ),
    ).toBe("What would you like to explore next?");
  });

  test("strips markdown emphasis and list markers", () => {
    expect(extractFollowUpQuestion("- **Which option** do you prefer?")).toBe(
      "Which option do you prefer?",
    );
  });

  test("ignores a question mark inside a fenced code block", () => {
    expect(
      extractFollowUpQuestion(
        "Try this:\n\n```js\nconst x = a ? b : c; // what?\n```",
      ),
    ).toBeNull();
  });

  test("falls back when the response does not end in a question", () => {
    expect(
      extractFollowUpQuestion("Here is the answer. That should cover it."),
    ).toBeNull();
  });

  test("falls back when a question is present but not at the end", () => {
    // Mid-response rhetorical questions are not an ask of the user.
    expect(
      extractFollowUpQuestion(
        "So what does that mean? It means the config was wrong.",
      ),
    ).toBeNull();
  });

  test("falls back on an implausibly long question rather than truncating", () => {
    const long = `${"why ".repeat(80)}?`;
    expect(extractFollowUpQuestion(long)).toBeNull();
  });

  test("falls back on punctuation-only or too-short endings", () => {
    expect(extractFollowUpQuestion("...\n\n?")).toBeNull();
    expect(extractFollowUpQuestion("Ok?")).toBeNull();
  });

  test("handles empty and whitespace input", () => {
    expect(extractFollowUpQuestion("")).toBeNull();
    expect(extractFollowUpQuestion("   \n\n  ")).toBeNull();
  });

  test("placeholder quotes the question", () => {
    expect(followUpPlaceholder("What next?")).toBe('Reply to: "What next?"');
  });
});

// Task 49 follow-on: whitespace that includes a newline must still count
// as empty, or the Run button enables for a composer holding nothing.
describe("isEmptyDoc treats hard breaks as whitespace", () => {
  test("a paragraph of spaces and a hard break is empty", () => {
    expect(
      isEmptyDoc({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "   " },
              { type: "hardBreak" },
              { type: "text", text: "\t " },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("real text alongside a hard break is still not empty", () => {
    expect(
      isEmptyDoc({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "hardBreak" }, { type: "text", text: "hello" }],
          },
        ],
      }),
    ).toBe(false);
  });
});
