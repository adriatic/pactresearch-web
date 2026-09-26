import { Fragment } from "react";
import type { JSONContent } from "@tiptap/core";
import type { RichContent } from "@/lib/richContent";

// Task 46 item B. Renders a prompt's stored rich content (the Tiptap doc
// in responses.prompt_content) instead of the flattened prompt_text.
//
// Task 43's response-panel inventory found prompt_content was written by
// /api/execute and read by nothing: History rendered prompt_text, in
// which docToPlainText turns every image into the literal four characters
// "[image]". So a prompt with a pasted image showed that placeholder
// where the image should be, even though the image was sitting in storage
// and its node in the doc the whole time.
//
// An explicit walk of the JSON rather than generating HTML and injecting
// it. @tiptap/html is not a dependency here, but more to the point this
// keeps the same property MarkdownResponse is careful about: nothing in a
// stored document can introduce markup of its own. Only the node and mark
// types the composer can actually produce are handled (StarterKit plus
// Image); anything unrecognised falls through to its text, never to raw
// output.

type Node = JSONContent;

function applyMarks(text: string, node: Node, key: string) {
  let el: React.ReactNode = text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        el = <strong>{el}</strong>;
        break;
      case "italic":
        el = <em>{el}</em>;
        break;
      case "strike":
        el = <s>{el}</s>;
        break;
      case "underline":
        el = <u>{el}</u>;
        break;
      case "code":
        el = <code>{el}</code>;
        break;
      case "link": {
        const href =
          typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        // noopener/noreferrer and an explicit target: a link in a stored
        // prompt is user-authored content being re-displayed later.
        el = (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {el}
          </a>
        );
        break;
      }
      default:
        break;
    }
  }
  // A keyed Fragment, not a <span>: unmarked text is the overwhelming
  // majority of prompt content, and wrapping every run of it in a span
  // would put a pointless element around almost every word while making
  // the rendered markup harder to reason about.
  return <Fragment key={key}>{el}</Fragment>;
}

function renderInline(nodes: Node[] | undefined, prefix: string) {
  return (nodes ?? []).map((n, i) => {
    const key = `${prefix}-${i}`;
    if (n.type === "text") return applyMarks(n.text ?? "", n, key);
    if (n.type === "hardBreak") return <br key={key} />;
    if (n.type === "image") return renderImage(n, key);
    return null;
  });
}

function renderImage(node: Node, key: string) {
  const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  if (!src) return null;
  // These are user-uploaded prompt images served through this app's own
  // /api/prompt-images route at unknown dimensions; next/image wants a
  // known width/height or a configured loader and buys nothing here.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={key}
      src={src}
      alt={alt}
      style={{ maxWidth: "100%", height: "auto", display: "block" }}
    />
  );
}

function renderBlock(node: Node, key: string): React.ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{renderInline(node.content, key)}</p>;
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      // Clamped and offset so a prompt's own headings cannot outrank the
      // page's structure -- the same hazard task 43's inventory flagged
      // for markdown responses rendering a real <h1> inside <main>.
      const Tag = `h${Math.min(6, Math.max(1, level) + 2)}` as "h3";
      return <Tag key={key}>{renderInline(node.content, key)}</Tag>;
    }
    case "bulletList":
      return (
        <ul key={key}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}-${i}`))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}-${i}`))}
        </ol>
      );
    case "listItem":
      return (
        <li key={key}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}-${i}`))}
        </li>
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}-${i}`))}
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{(node.content ?? []).map((c) => c.text ?? "").join("")}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    case "image":
      return renderImage(node, key);
    default:
      // Unknown block: show its text rather than dropping it silently.
      return <p key={key}>{renderInline(node.content, key)}</p>;
  }
}

// True when the doc is a single paragraph of unformatted text -- by far
// the common case. Those keep rendering inline after the "Prompt:" label
// exactly as they did before this change, so the overwhelming majority of
// history entries are untouched by it.
export function simpleTextOf(doc: RichContent | null): string | null {
  if (!doc || doc.type !== "doc") return null;
  const blocks = doc.content ?? [];
  if (blocks.length !== 1) return null;
  const only = blocks[0];
  if (only.type !== "paragraph") return null;
  const inline = only.content ?? [];
  if (inline.some((n) => n.type !== "text" || (n.marks ?? []).length > 0)) {
    return null;
  }
  return inline.map((n) => n.text ?? "").join("");
}

export function PromptContent({ content }: { content: RichContent }) {
  return (
    <>{(content.content ?? []).map((node, i) => renderBlock(node, `b-${i}`))}</>
  );
}
