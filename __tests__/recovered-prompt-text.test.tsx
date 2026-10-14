import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  docToPlainText,
  docToRecoveredText,
  type RichContent,
} from "@/lib/richContent";
import { GoneNotice, picturesNotRecoveredText } from "@/app/GoneNotice";

// Task 93. The unsent prompt offered back after a deletion in another tab
// numbers its pictures in order and says they cannot be recovered. The
// stored prompt_text (docToPlainText) keeps "[image]".

afterEach(cleanup);

const p = (text: string): RichContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const img = (n: number): RichContent => ({
  type: "image",
  attrs: { src: `/api/prompt-images/u/d/${n}.png`, alt: null },
});
const doc = (...content: RichContent[]): RichContent => ({
  type: "doc",
  content,
});

describe("docToRecoveredText", () => {
  test("no picture: the same text as before, nothing numbered", () => {
    const d = doc(p("first"), p("second"));
    expect(docToRecoveredText(d)).toEqual({
      text: docToPlainText(d),
      pictureCount: 0,
    });
    expect(docToRecoveredText(d).text).toBe("first\n\nsecond");
  });

  test("one picture between texts", () => {
    expect(docToRecoveredText(doc(p("before"), img(1), p("after")))).toEqual({
      text: "before\n\n[picture 1]\n\nafter",
      pictureCount: 1,
    });
  });

  test("two pictures mixed with text, numbered in order", () => {
    expect(
      docToRecoveredText(doc(p("A"), img(1), p("B"), img(2), p("C"))),
    ).toEqual({
      text: "A\n\n[picture 1]\n\nB\n\n[picture 2]\n\nC",
      pictureCount: 2,
    });
  });

  test("three or more, including two in a row and one first", () => {
    expect(
      docToRecoveredText(doc(img(1), p("A"), img(2), img(3), p("B"), img(4))),
    ).toEqual({
      text: "[picture 1]\n\nA\n\n[picture 2]\n\n[picture 3]\n\nB\n\n[picture 4]",
      pictureCount: 4,
    });
  });

  test("the stored text is unchanged: still [image]", () => {
    expect(docToPlainText(doc(p("A"), img(1), p("B"), img(2)))).toBe(
      "A\n\n[image]\n\nB\n\n[image]",
    );
  });
});

describe("picturesNotRecoveredText", () => {
  test.each([
    [0, null],
    [1, "Your picture cannot be recovered; [picture 1] shows where it was."],
    [
      2,
      "Your 2 pictures cannot be recovered; [picture 1] and [picture 2] show where they were.",
    ],
    [
      3,
      "Your 3 pictures cannot be recovered; [picture 1] to [picture 3] show where they were.",
    ],
    [
      7,
      "Your 7 pictures cannot be recovered; [picture 1] to [picture 7] show where they were.",
    ],
  ])("%i", (count, expected) => {
    expect(picturesNotRecoveredText(count)).toBe(expected);
  });
});

describe("GoneNotice", () => {
  const message = "This discussion was deleted in another tab or window.";

  test("with pictures: the sentence is shown, and Show it has the numbered text", () => {
    render(
      <GoneNotice
        notebookCount={1}
        notice={{
          message,
          unsentText: "A\n\n[picture 1]\n\nB\n\n[picture 2]",
          unsentPictureCount: 2,
        }}
      />,
    );
    expect(
      screen.getByText(
        "Your 2 pictures cannot be recovered; [picture 1] and [picture 2] show where they were.",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-unsent-prompt] pre")?.textContent,
    ).toBe("A\n\n[picture 1]\n\nB\n\n[picture 2]");
  });

  test("without pictures: no sentence", () => {
    render(
      <GoneNotice
        notebookCount={1}
        notice={{ message, unsentText: "just text", unsentPictureCount: 0 }}
      />,
    );
    expect(document.querySelector("[data-unsent-pictures]")).toBeNull();
    expect(screen.queryByText(/cannot be recovered/)).toBeNull();
  });
});
