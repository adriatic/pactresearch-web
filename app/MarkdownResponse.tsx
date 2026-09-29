import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  maskUnpairedMathFence,
  normalizeLatexDelimiters,
} from "@/lib/latexDelimiters";
// KaTeX ships the fonts and layout rules its output depends on. Without
// this the markup renders but looks like unstyled spans -- which is a
// different flavour of unreadable from the raw LaTeX it replaces.
import "katex/dist/katex.min.css";

// Renders a response's markdown (headers, bold/italic, lists, tables,
// code blocks) as real formatting instead of raw source text -- used for
// both the live-streaming view and the history/reload view, so a
// response looks the same whichever way it's currently being read.
//
// Safe by design, not just by convention: react-markdown parses to an
// AST and never renders raw HTML unless rehype-raw is added (it isn't
// here) -- so literal HTML/script-looking text in a response (including
// anything an adversarial prompt might coax the model into producing)
// renders as inert text, never executes.
//
// Task 64. Math renders as typeset output rather than raw source:
// remark-math finds the delimiters, rehype-katex typesets them. A
// response containing a Lagrangian used to show "$$\frac{1}{2} m
// \ell^2 \dot{\theta}^2$$" literally on screen.
//
// SINGLE-DOLLAR INLINE MATH IS DISABLED, and that is the one real
// judgement call here. With it on, "It costs $50 and $60 total"
// parses "$50 and $" as an equation -- prose about money silently
// turns into nonsense, which is worse than the problem being fixed
// because the reader cannot tell it happened. Measured both ways
// before choosing; the test named MEASURED renders the rejected
// setting and shows exactly what it does to that sentence.
//
// Turning it off would otherwise cost us inline math entirely, so
// normalizeLatexDelimiters first rewrites Claude's other convention
// -- \(...\) and \[...\] -- into the dollar form. Inline math is
// therefore fully supported; it just arrives by the delimiter Claude
// actually uses when it isn't using dollars.
//
// Mid-stream, `content` is necessarily incomplete/malformed (an unclosed
// **, a table that hasn't finished) -- verified directly (not assumed)
// that react-markdown/remark-gfm never throws on this: unclosed spans
// fall back to their literal characters, an in-progress table/list still
// renders as much as has arrived, and it simply re-renders correctly
// once the stream completes. No error boundary needed for this reason.
export function MarkdownResponse({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[rehypeKatex]}
    >
      {maskUnpairedMathFence(normalizeLatexDelimiters(content))}
    </ReactMarkdown>
  );
}
