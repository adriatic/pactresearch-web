import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { MarkdownResponse } from "@/app/MarkdownResponse";

// Task 64. A response containing a Lagrangian used to show its LaTeX
// source on screen -- "$$\frac{1}{2} m \ell^2 \dot{\theta}^2$$" as
// literal characters.
//
// KaTeX output is identified by its own `.katex` wrapper class, which
// is a stable part of its public output contract. Asserting on that,
// rather than on rendered glyphs, keeps these tests about "was this
// typeset" rather than about KaTeX's internal markup.

afterEach(cleanup);

function typeset(container: HTMLElement) {
  return container.querySelectorAll(".katex").length;
}

// KaTeX emits the original TeX twice: once as typeset HTML, and once as a
// MathML <annotation> for screen readers and copy-paste. The annotation is
// visually hidden, so asserting "the source is gone" has to ignore it --
// otherwise every passing render still looks like it leaked raw LaTeX.
function visibleText(container: HTMLElement) {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".katex-mathml").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

const LAGRANGIAN =
  "\\frac{1}{2} m \\ell^2 \\dot{\\theta}^2 + m g \\ell \\cos\\theta";

describe("math rendering", () => {
  test("Nik's pendulum block renders as typeset math, not raw LaTeX", () => {
    const { container } = render(
      <MarkdownResponse
        content={`The Lagrangian is:\n\n$$${LAGRANGIAN}$$\n`}
      />,
    );
    expect(typeset(container)).toBeGreaterThan(0);
    // The source must not survive as visible text.
    expect(visibleText(container)).not.toContain("\\frac");
    expect(visibleText(container)).not.toContain("\\dot");
    expect(visibleText(container)).not.toContain("$$");
  });

  test("inline math inside a sentence renders", () => {
    const { container } = render(
      <MarkdownResponse content={"Then \\(E = mc^2\\) follows directly."} />,
    );
    expect(typeset(container)).toBe(1);
    expect(container.textContent).toContain("follows directly");
    expect(visibleText(container)).not.toContain("\\(");
  });

  test("display math via \\[...\\] renders too", () => {
    const { container } = render(
      <MarkdownResponse content={"\\[ x^2 + y^2 = z^2 \\]"} />,
    );
    expect(typeset(container)).toBeGreaterThan(0);
  });

  // The brief's item 4: nested inside other markdown structures.
  test("math renders inside a list item", () => {
    const { container } = render(
      <MarkdownResponse
        content={"- kinetic term \\(T = \\tfrac{1}{2}mv^2\\)\n- second item\n"}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("li .katex").length).toBeGreaterThan(0);
  });

  test("math renders inside a table cell", () => {
    const { container } = render(
      <MarkdownResponse
        content={
          "| symbol | meaning |\n| --- | --- |\n| \\(\\theta\\) | angle |\n"
        }
      />,
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("td .katex").length).toBeGreaterThan(0);
  });

  test("math renders inside a blockquote", () => {
    const { container } = render(
      <MarkdownResponse content={"> recall \\(a^2 + b^2 = c^2\\)\n"} />,
    );
    expect(
      container.querySelectorAll("blockquote .katex").length,
    ).toBeGreaterThan(0);
  });
});

// The brief's item 5, and the reason for the singleDollarTextMath
// decision. These two blocks are the measurement the component comment
// refers to -- the second shows what the rejected setting actually does.
// Backs the claim in lib/latexDelimiters.ts that the rewrite has to run
// on the source string rather than as a remark plugin. If this ever
// stops holding, the whole module is unnecessary.
describe("why the rewrite happens before parsing", () => {
  test("CommonMark eats the backslash before an mdast plugin could see it", () => {
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkMath, { singleDollarTextMath: false }],
        ]}
        rehypePlugins={[rehypeKatex]}
      >
        {"Since \\(E = mc^2\\) holds."}
      </ReactMarkdown>,
    );
    // Not "\\(E = mc^2\\)": the escapes are already resolved, so the
    // delimiters no longer exist in the tree a plugin would walk.
    expect(container.textContent).toBe("Since (E = mc^2) holds.");
  });
});

describe("display mode follows where the equation sat", () => {
  // .katex-display is the centred, own-line presentation. An equation on
  // its own gets it; one inside a sentence must not, or the prose breaks
  // apart around it.
  test("$$ on its own lines is display math", () => {
    const { container } = render(
      <MarkdownResponse content={"Given:\n\n$$\nE = mc^2\n$$\n"} />,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  test("\\[...\\] on its own is display math", () => {
    const { container } = render(
      <MarkdownResponse content={"Given:\n\n\\[ E = mc^2 \\]\n"} />,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  test("\\(...\\) mid-sentence is inline, not display", () => {
    const { container } = render(
      <MarkdownResponse content={"Since \\(E = mc^2\\), mass is energy."} />,
    );
    expect(typeset(container)).toBe(1);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(0);
    // The sentence must still read as one sentence.
    expect(visibleText(container)).toContain(", mass is energy.");
  });

  test("a matrix with \\\\ row separators survives the rewrite", () => {
    const { container } = render(
      <MarkdownResponse
        content={
          "Given:\n\n\\[ \\begin{matrix} a & b \\\\ c & d \\end{matrix} \\]\n"
        }
      />,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(visibleText(container)).not.toContain("\\begin");
  });

  test("two equations in one paragraph both render", () => {
    const { container } = render(
      <MarkdownResponse
        content={"Compare \\(a^2\\) with \\(b^2\\) directly."}
      />,
    );
    expect(typeset(container)).toBe(2);
  });
});

describe("dollar signs in prose", () => {
  test("currency is left completely alone", () => {
    const { container } = render(
      <MarkdownResponse
        content={"It costs $50 and $60 total, or $1,200 a year."}
      />,
    );
    expect(typeset(container)).toBe(0);
    expect(container.textContent).toContain("$50 and $60 total");
    expect(container.textContent).toContain("$1,200");
  });

  test("a lone dollar amount is untouched", () => {
    const { container } = render(<MarkdownResponse content={"Costs $50."} />);
    expect(typeset(container)).toBe(0);
    expect(container.textContent).toContain("$50.");
  });

  // Why singleDollarTextMath is off: with it ON, the sentence above
  // silently becomes an equation. Rendered here with the rejected
  // configuration so the trade-off is demonstrated rather than asserted
  // in a comment.
  test("MEASURED: the rejected setting really does mangle currency", () => {
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkMath, { singleDollarTextMath: true }],
        ]}
        rehypePlugins={[rehypeKatex]}
      >
        {"It costs $50 and $60 total."}
      </ReactMarkdown>,
    );
    // "$50 and $" is parsed as inline math.
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("$50 and $60 total");
  });
});

describe("existing markdown still renders", () => {
  test("headings, lists, tables and code are unaffected", () => {
    const { container } = render(
      <MarkdownResponse
        content={
          "# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n"
        }
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const x = 1;",
    );
  });

  test("dollars inside a code block stay literal", () => {
    const { container } = render(
      <MarkdownResponse content={"```\ntotal=$50 and $60\n```\n"} />,
    );
    expect(container.querySelector("pre code")?.textContent).toContain(
      "total=$50 and $60",
    );
    expect(typeset(container)).toBe(0);
  });

  // The normalizer rewrites \\( and \\[ on the raw source, so it has to
  // step over code regions or it corrupts the one place where those
  // characters are meant to be read literally.
  test("LaTeX delimiters inside a fenced code block stay literal", () => {
    const source = [
      "```",
      "escape it as \\(x\\) in the source",
      "```",
      "",
    ].join("\n");
    const { container } = render(<MarkdownResponse content={source} />);
    expect(typeset(container)).toBe(0);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "\\(x\\)",
    );
  });

  test("LaTeX delimiters inside an inline code span stay literal", () => {
    const { container } = render(
      <MarkdownResponse content={"Write `\\(x\\)` to get inline math."} />,
    );
    expect(typeset(container)).toBe(0);
    expect(container.querySelector("code")?.textContent).toBe("\\(x\\)");
  });

  // Streaming sends partial content; an unterminated delimiter must not
  // throw, the way the component comment already promises for markdown.
  test("a half-arrived equation does not throw mid-stream", () => {
    expect(() =>
      render(
        <MarkdownResponse content={"The Lagrangian is:\n\n$$\\frac{1}{2} m"} />,
      ),
    ).not.toThrow();
  });

  test("a half-arrived \\(...\\) does not throw mid-stream", () => {
    expect(() =>
      render(<MarkdownResponse content={"Since \\(E = mc"} />),
    ).not.toThrow();
  });

  test("invalid LaTeX does not blow up the whole response", () => {
    const { container } = render(
      <MarkdownResponse content={"Before.\n\n$$\n\\frac{1}{\n$$\n\nAfter."} />,
    );
    expect(container.textContent).toContain("Before.");
    expect(container.textContent).toContain("After.");
  });
});
