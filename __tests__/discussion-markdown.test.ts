import { describe, expect, test } from "vitest";
import {
  discussionExportFilename,
  renderDiscussionMarkdown,
} from "@/lib/discussionMarkdown";

const EXPORTED_AT = new Date("2026-09-29T18:30:00.000Z");

function render(
  turns: { prompt: string; response: string | null }[],
  overrides: Partial<{ discussionName: string; notebookName: string }> = {},
) {
  return renderDiscussionMarkdown({
    discussionName: overrides.discussionName ?? "Simple pendulum",
    notebookName: overrides.notebookName ?? "Classical mechanics",
    exportedAt: EXPORTED_AT,
    turns,
  });
}

describe("the document as a whole", () => {
  // Asserted in full rather than by probing for substrings: this is the
  // file a human opens, and its exact shape -- where the blank lines
  // fall, what separates two turns -- is the deliverable.
  test("a two-turn discussion renders exactly this", () => {
    expect(
      render([
        { prompt: "What is the Lagrangian?", response: "It is T minus V." },
        { prompt: "And the equation of motion?", response: "Euler-Lagrange." },
      ]),
    ).toBe(
      [
        "# Simple pendulum",
        "",
        "From notebook **Classical mechanics** · exported 29 September 2026",
        "",
        "---",
        "",
        "## Turn 1",
        "",
        "**Prompt**",
        "",
        "What is the Lagrangian?",
        "",
        "**Response**",
        "",
        "It is T minus V.",
        "",
        "---",
        "",
        "## Turn 2",
        "",
        "**Prompt**",
        "",
        "And the equation of motion?",
        "",
        "**Response**",
        "",
        "Euler-Lagrange.",
        "",
      ].join("\n"),
    );
  });

  test("turns appear in the order they were given", () => {
    const markdown = render([
      { prompt: "first", response: "one" },
      { prompt: "second", response: "two" },
      { prompt: "third", response: "three" },
    ]);
    expect(markdown.indexOf("one")).toBeLessThan(markdown.indexOf("two"));
    expect(markdown.indexOf("two")).toBeLessThan(markdown.indexOf("three"));
    expect(markdown.match(/^## Turn \d+$/gm)).toEqual([
      "## Turn 1",
      "## Turn 2",
      "## Turn 3",
    ]);
  });

  test("a discussion with no turns says so instead of ending mid-air", () => {
    expect(render([])).toContain("_This discussion has no turns yet._");
    expect(render([])).not.toContain("## Turn");
  });

  // The whole point of markdown over .pact: nothing a reader did not ask
  // for. This is a negative assertion on the rendered file, so a future
  // change that starts including metadata trips it.
  test("no ids, timestamps or model internals reach the file", () => {
    const markdown = render([{ prompt: "hello", response: "hi" }]);
    expect(markdown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // uuid
    expect(markdown).not.toMatch(/\d{2}:\d{2}:\d{2}/); // clock time
    expect(markdown).not.toMatch(/claude-/i);
    expect(markdown).not.toMatch(/\bms\b/);
  });
});

describe("response content is framed, not re-encoded", () => {
  test("a fenced code block survives verbatim", () => {
    const response = [
      "Here you go:",
      "",
      "```python",
      "def f(x):",
      "    return x ** 2  # note the *asterisks*",
      "```",
    ].join("\n");
    expect(render([{ prompt: "code please", response }])).toContain(response);
  });

  test("lists and tables survive verbatim", () => {
    const response = [
      "- first",
      "- second",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");
    expect(render([{ prompt: "p", response }])).toContain(response);
  });

  test("markdown special characters are not escaped", () => {
    const response = "Use **bold**, _italic_, `code` and [a link](https://x).";
    expect(render([{ prompt: "p", response }])).toContain(response);
    expect(render([{ prompt: "p", response }])).not.toContain("\\*");
  });

  // A turn ending in text, followed by the "---" that starts the next
  // one, must not turn that text into a setext heading.
  test("a blank line always precedes the turn separator", () => {
    const markdown = render([
      { prompt: "p", response: "the last line of a response" },
      { prompt: "p2", response: "r2" },
    ]);
    expect(markdown).toContain("the last line of a response\n\n---\n");
    expect(markdown).not.toMatch(/[^\n]\n---/);
  });
});

describe("incomplete turns", () => {
  test("a null response is marked, and its prompt is kept", () => {
    const markdown = render([
      { prompt: "still thinking about this one", response: null },
    ]);
    expect(markdown).toContain("still thinking about this one");
    expect(markdown).toContain(
      "_No response recorded — this turn did not complete._",
    );
  });

  test("a blank response is treated the same as a missing one", () => {
    expect(render([{ prompt: "p", response: "   \n  " }])).toContain(
      "_No response recorded — this turn did not complete._",
    );
  });

  test("an incomplete turn does not disturb the ones around it", () => {
    const markdown = render([
      { prompt: "a", response: "answer a" },
      { prompt: "b", response: null },
      { prompt: "c", response: "answer c" },
    ]);
    expect(markdown.match(/^## Turn \d+$/gm)).toHaveLength(3);
    expect(markdown).toContain("answer a");
    expect(markdown).toContain("answer c");
  });
});

describe("math", () => {
  test("$$ display math is left as it is", () => {
    const response = "Given:\n\n$$\nE = mc^2\n$$";
    expect(render([{ prompt: "p", response }])).toContain(response);
  });

  // The app rewrites \(...\) so KaTeX can typeset it; the export does the
  // same so the file is not the one place the equation stays as source.
  test("\\(...\\) becomes inline $...$ so a viewer can typeset it", () => {
    const markdown = render([
      { prompt: "p", response: "Since \\(E = mc^2\\), mass is energy." },
    ]);
    expect(markdown).toContain("Since $E = mc^2$, mass is energy.");
    expect(markdown).not.toContain("\\(");
  });

  // Written to a file a human opens, so the blank lines around a display
  // block are part of the output, not just parser food.
  test("a display block is separated by exactly one blank line", () => {
    const markdown = render([
      {
        prompt: "p",
        response: "Given:\n\n\\[ E = mc^2 \\]\n\nwhich follows.",
      },
    ]);
    expect(markdown).toContain("Given:\n\n$$\nE = mc^2\n$$\n\nwhich follows.");
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  test("\\[...\\] becomes a $$ display block", () => {
    const markdown = render([
      { prompt: "p", response: "Given \\[ E = mc^2 \\] we can say more." },
    ]);
    expect(markdown).toContain("$$\nE = mc^2\n$$");
  });

  // Inline uses one dollar here, unlike the app, and that is the one
  // place the two deliberately differ -- "$$" mid-sentence is a display
  // block to GitHub, which would break the sentence onto its own line.
  test("inline math is single-dollar, not the app's double", () => {
    const markdown = render([{ prompt: "p", response: "so \\(x^2\\) holds" }]);
    expect(markdown).toContain("so $x^2$ holds");
    expect(markdown).not.toContain("$$x^2$$");
  });

  test("currency in a response is never touched", () => {
    const response = "The rig costs $50 and $60, or $1,200 a year.";
    expect(render([{ prompt: "p", response }])).toContain(response);
  });

  test("LaTeX inside a code block stays literal", () => {
    const response = ["```", "write \\(x\\) for inline math", "```"].join("\n");
    expect(render([{ prompt: "p", response }])).toContain(response);
  });
});

describe("filename", () => {
  test("discussion name plus the date, as markdown", () => {
    expect(discussionExportFilename("Simple pendulum", EXPORTED_AT)).toBe(
      "Simple-pendulum-2026-09-29.md",
    );
  });

  test("characters a filesystem would object to are collapsed", () => {
    expect(
      discussionExportFilename('Q3: "revenue" / margins?', EXPORTED_AT),
    ).toBe("Q3-revenue-margins-2026-09-29.md");
  });

  test("a name with nothing usable in it still produces a filename", () => {
    expect(discussionExportFilename("???", EXPORTED_AT)).toBe(
      "discussion-2026-09-29.md",
    );
  });
});
