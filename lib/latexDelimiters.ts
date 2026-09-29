// Task 64. Claude emits math with two different delimiter conventions:
// "$$...$$" and the LaTeX-native "\(...\)" / "\[...\]". remark-math only
// understands the dollar form, so the LaTeX form used to reach the screen
// as literal backslashes and brackets.
//
// This has to happen on the source string, before markdown is parsed.
// CommonMark treats a backslash before any ASCII punctuation as a
// character escape, so by the time there is an mdast to walk, "\(" has
// already become a bare "(" and the delimiter is gone. A remark plugin
// is the wrong layer; verified, not assumed -- see the tests.
//
// Display math always becomes "$$...$$". The inline delimiter is a
// parameter because the two consumers need different answers, and the
// reason is worth stating once here rather than being rediscovered:
//
//   In the app (MarkdownResponse) inline math is "$$...$$" too, because
//   single-dollar math is deliberately OFF -- with it on, "it costs $50
//   and $60" parses "$50 and $" as an equation. remark-math reads "$$"
//   mid-sentence as inline and "$$" on its own line as display, so one
//   delimiter covers both and currency is never at risk.
//
//   In an exported markdown file (task 65) inline math is "$...$",
//   because the file is read by viewers we do not control, and "$...$"
//   inline / "$$...$$" display is the convention they implement. GitHub
//   in particular documents "$" as the inline form and "$$" as a block,
//   so "$$" mid-sentence would break the sentence onto its own line.
//   This only ever ADDS dollars where the author wrote "\(...\)"; an
//   existing "$50" in the text is never touched. Measured, for the
//   obvious worry: a viewer with single-dollar math on already mangles
//   "costs $50 and $60" in a sentence containing no math at all, so the
//   pairing is its configuration meeting the model's own text, not
//   something this rewrite creates -- and "$$" would not avoid it. Test
//   in __tests__/discussion-markdown-renders.test.tsx.
//
// Same scan, same protected regions, one parameter -- so the two cannot
// drift apart in anything except that deliberate choice.
export type InlineMathDelimiter = "$" | "$$";

// Regions whose contents must survive verbatim: fenced code, inline code,
// and math that already uses the dollar form. Kept as one alternation so
// splitting on it yields alternating pass-through/rewritable segments.
//
// The unterminated-fence branch is `(?![\s\S])` -- end of input -- and not
// `$`. With the m flag `$` matches at the end of the opening fence's own
// line, so the lazy body matched nothing and a fence protected only its
// own backticks. A test in markdown-math covers exactly that.
const PROTECTED =
  /(^ {0,3}(?:`{3,}|~{3,})[\s\S]*?(?:^ {0,3}(?:`{3,}|~{3,}).*$|(?![\s\S]))|`+[^`\n]*`+|\$\$[\s\S]*?\$\$)/gm;

// One alternation, one left-to-right scan. Two separate .replace() passes
// would re-scan text the first pass had already produced, so a display
// block containing LaTeX's own backslashes (the "\\" row separator in a
// matrix, say) could be re-matched from the inside. Scanning once means
// each delimited region is consumed whole.
const LATEX = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

function rewrite(segment: string, inlineDelimiter: InlineMathDelimiter) {
  return segment.replace(
    LATEX,
    (
      match: string,
      display: string | undefined,
      inline: string | undefined,
      offset: number,
      whole: string,
    ) => {
      if (display === undefined) {
        return `${inlineDelimiter}${(inline ?? "").trim()}${inlineDelimiter}`;
      }
      // Display math has to start its own line for remark-math to read
      // it as display, so a newline is added only where there is not one
      // already. Adding them unconditionally is invisible in the app --
      // the renderer collapses blank lines -- but task 65 writes this
      // same output to a file a human opens in a text editor, where an
      // equation surrounded by two blank lines on each side looks like
      // a mistake.
      const lead = whole.slice(0, offset).endsWith("\n") ? "" : "\n";
      const tail = whole.slice(offset + match.length).startsWith("\n")
        ? ""
        : "\n";
      return `${lead}$$\n${display.trim()}\n$$${tail}`;
    },
  );
}

// Streaming delivers a response a few characters at a time, so a "$$"
// block spends a moment open with only half an equation inside it.
// remark-math closes an unterminated block at end of input and KaTeX
// then renders the fragment as red error text -- measured: at one frame
// of "L = \frac{1}{2} m v^2" arriving, the panel showed a katex-error
// span for "\frac". Every equation would flash red on its way in.
//
// An unpaired "$$" is therefore left as literal text until its partner
// arrives. PROTECTED already captures balanced pairs, so anything still
// sitting in an unprotected segment is an opener with no closer.
// Exported because it is a *streaming* concern, not part of delimiter
// normalisation: a stored, finished response has no half-open fence, and
// masking one in an exported file would put literal backslashes in front
// of the reader. MarkdownResponse composes the two; the export does not.
export function maskUnpairedMathFence(text: string): string {
  return text
    .split(PROTECTED)
    .map((segment, index) =>
      index % 2 === 1 ? segment : (segment ?? "").replaceAll("$$", "\\$\\$"),
    )
    .join("");
}

export function normalizeLatexDelimiters(
  source: string,
  inlineDelimiter: InlineMathDelimiter = "$$",
): string {
  // split() with a capturing group keeps the delimiters, so the protected
  // regions land at the odd indices and are copied through untouched.
  return source
    .split(PROTECTED)
    .map((segment, index) =>
      index % 2 === 1 ? segment : rewrite(segment ?? "", inlineDelimiter),
    )
    .join("");
}
