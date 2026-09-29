import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { renderDiscussionMarkdown } from "@/lib/discussionMarkdown";

// Task 65, the brief's "confirm the downloaded file opens cleanly as
// plain markdown" check, done as an assertion rather than by eye: the
// exported document is put through a real markdown pipeline and the
// result inspected for the structure it is supposed to have.
//
// Single-dollar math is ON here, unlike the app's own renderer. That is
// the point: the export uses "$...$" for inline math precisely because
// that is what a third-party viewer implements, so the viewer simulated
// here has to be configured like a third-party one, not like us.
function viewer(markdown: string) {
  return render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {markdown}
    </ReactMarkdown>,
  ).container;
}

const DOCUMENT = renderDiscussionMarkdown({
  discussionName: "Simple pendulum",
  notebookName: "Classical mechanics",
  exportedAt: new Date("2026-09-29T18:30:00.000Z"),
  turns: [
    {
      prompt: "What is the Lagrangian?",
      response: [
        "It is \\(T - V\\). Steps:",
        "",
        "1. write the kinetic term",
        "2. subtract the potential",
        "",
        "```python",
        "def L(T, V):",
        "    return T - V",
        "```",
        "",
        "| symbol | meaning |",
        "| --- | --- |",
        "| T | kinetic |",
      ].join("\n"),
    },
    { prompt: "And the equations of motion?", response: null },
  ],
});

describe("the exported file, opened in a markdown viewer", () => {
  test("the title and turn headings come out as real headings", () => {
    const container = viewer(DOCUMENT);
    expect(container.querySelector("h1")?.textContent).toBe("Simple pendulum");
    expect(
      [...container.querySelectorAll("h2")].map((h) => h.textContent),
    ).toEqual(["Turn 1", "Turn 2"]);
  });

  test("the code block, list and table are structure, not text", () => {
    const container = viewer(DOCUMENT);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "return T - V",
    );
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  test("the equation typesets rather than showing its own delimiters", () => {
    const container = viewer(DOCUMENT);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("\\(");
  });

  test("the turn separators are rules, not stray text", () => {
    const container = viewer(DOCUMENT);
    expect(container.querySelectorAll("hr")).toHaveLength(2);
    // A "---" swallowed as a setext underline would have eaten the line
    // above it instead of producing an <hr>.
    expect(container.textContent).not.toContain("---");
  });

  test("the incomplete turn reads as a note, not as an empty answer", () => {
    const container = viewer(DOCUMENT);
    expect(container.textContent).toContain(
      "No response recorded — this turn did not complete.",
    );
    expect(container.querySelector("em")?.textContent).toBeTruthy();
  });

  test("no markdown source characters survive as visible text", () => {
    const container = viewer(DOCUMENT);
    expect(container.textContent).not.toContain("**Prompt**");
    expect(container.textContent).not.toContain("## Turn");
    expect(container.textContent).toContain("Prompt");
    expect(container.textContent).toContain("Response");
  });
});

// Why the export uses "$...$" for inline math even though a viewer with
// single-dollar math on will mangle currency: it mangles it anyway.
// Measured here rather than argued -- the first case contains no math
// and nothing the export added, and it still comes out wrong. The
// pairing is a property of the reader's own configuration and of text
// the model wrote, not of anything this feature does, and using "$$"
// instead would not avoid it.
describe("currency in a third-party viewer", () => {
  const PROSE = "The rig costs $50 and $60, and no math at all.";

  test("a viewer with single-dollar math on mangles currency unaided", () => {
    const container = viewer(PROSE);
    expect(container.querySelectorAll(".katex").length).toBe(1);
    expect(container.textContent).not.toContain("$50 and $60");
  });

  test("adding inline math to that sentence changes nothing about it", () => {
    const exported = renderDiscussionMarkdown({
      discussionName: "d",
      notebookName: "n",
      exportedAt: new Date("2026-09-29T00:00:00.000Z"),
      turns: [
        {
          prompt: "p",
          response: "The rig costs $50 and $60, and \\(x^2\\) is the scaling.",
        },
      ],
    });
    // The equation does typeset, which is the improvement; the currency
    // is no worse off than in the case above.
    expect(exported).toContain("$x^2$");
    const container = viewer(exported);
    expect(container.querySelectorAll(".katex").length).toBe(2);
  });
});
