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
// Both forms are rewritten to "$$...$$" rather than "$...$" because
// single-dollar math is deliberately off (see MarkdownResponse): with it
// on, "it costs $50 and $60" parses "$50 and $" as an equation. The
// dollar pair does double duty -- remark-math reads "$$" at the start of
// a line as display math and "$$" mid-sentence as inline math -- so the
// same rewrite gets the right presentation from where the equation sat
// in the original text.

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

function rewrite(segment: string): string {
  return segment.replace(
    LATEX,
    (_match, display: string | undefined, inline: string | undefined) =>
      display === undefined
        ? `$$${(inline ?? "").trim()}$$`
        : `\n$$\n${display.trim()}\n$$\n`,
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
function maskUnpairedMathFence(text: string): string {
  return text
    .split(PROTECTED)
    .map((segment, index) =>
      index % 2 === 1 ? segment : (segment ?? "").replaceAll("$$", "\\$\\$"),
    )
    .join("");
}

export function normalizeLatexDelimiters(source: string): string {
  // split() with a capturing group keeps the delimiters, so the protected
  // regions land at the odd indices and are copied through untouched.
  const rewritten = source
    .split(PROTECTED)
    .map((segment, index) =>
      index % 2 === 1 ? segment : rewrite(segment ?? ""),
    )
    .join("");
  return maskUnpairedMathFence(rewritten);
}
