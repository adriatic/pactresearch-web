import type { JSONContent } from "@tiptap/core";

// Shared, pure, framework-agnostic helpers for the rich composer's content
// shape (Tiptap/ProseMirror JSON) -- safe to import from both client
// components (Composer.tsx, useDiscussionExecution.ts) and server routes
// (execute, discussions), since none of this touches a live editor
// instance or the DOM. Kept deliberately separate from
// lib/promptContentToMarkdownBlocks.ts (which needs a real Tiptap schema)
// -- these three functions only ever look at plain JSON.

export type RichContent = JSONContent;

export const EMPTY_DOC: RichContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

// Wraps a plain string into a single-paragraph doc -- the backward-
// compatibility bridge for every pre-rebuild plain-text value this app
// already has on disk (discussions.draft_prompt_text, responses.prompt_text)
// and will keep having until each row is next touched by the new composer.
// Splits on newlines into separate paragraphs rather than folding
// everything into one, so a multi-line legacy draft doesn't collapse into
// a single run-on paragraph.
export function plainTextToDoc(text: string): RichContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

// True for a doc with no content at all, or content that's nothing but
// empty paragraphs (the shape Tiptap itself produces for "the user typed
// something then deleted it all," and what EMPTY_DOC represents) -- the
// JSON-doc equivalent of an empty string, used everywhere the old code
// checked promptText.trim().length === 0 (the Run button's disabled
// state, the outgoing-draft-save guard's "is there anything to save").
// A genuinely plain-text extraction -- no Markdown syntax, unlike the
// Markdown conversion lib/promptContentToMarkdownBlocks.ts does for
// Anthropic (that one preserves emphasis as **bold**/*italic* for the
// model's benefit; this one is for responses.prompt_text, still read by
// .pact export, History, and admin/timings exactly as a plain string,
// none of which expect Markdown syntax embedded in it). Images become a
// "[image]" placeholder rather than silently vanishing. Deliberately not
// using the ProseMirror/prosemirror-markdown machinery at all -- this is
// a much simpler walk of the raw JSON, no Schema/Node construction
// needed, since there's no formatting syntax to get right.
export function docToPlainText(doc: RichContent): string {
  return docToText(doc, () => "[image]");
}

// Task 93. The same text for an unsent prompt offered back after a
// deletion in another tab, but with the pictures numbered in order
// ("[picture 1]", "[picture 2]", ...) so the user can see where each one
// was -- the pictures themselves are gone by then. Kept apart from
// docToPlainText, whose "[image]" is stored in responses.prompt_text and
// read by History and .pact export.
export function docToRecoveredText(doc: RichContent): {
  text: string;
  pictureCount: number;
} {
  let pictureCount = 0;
  const text = docToText(doc, () => `[picture ${++pictureCount}]`);
  return { text, pictureCount };
}

function docToText(doc: RichContent, imagePlaceholder: () => string): string {
  const paragraphs: string[] = [];

  for (const node of doc.content ?? []) {
    if (node.type === "image") {
      paragraphs.push(imagePlaceholder());
      continue;
    }
    const text = flattenInlineText(node);
    if (text.length > 0) paragraphs.push(text);
  }

  return paragraphs.join("\n\n");
}

function flattenInlineText(node: RichContent): string {
  if (node.type === "text") return node.text ?? "";
  if (!node.content) return "";
  return node.content.map(flattenInlineText).join("");
}

export function isEmptyDoc(doc: RichContent | null | undefined): boolean {
  if (!doc || !doc.content) return true;
  return doc.content.every((node) => {
    if (node.type !== "paragraph") return false;
    if (!node.content || node.content.length === 0) return true;
    return node.content.every((child) => {
      // A hard break is whitespace, not content. Task 49 found Run
      // enabling for a composer holding only spaces and a newline:
      // Tiptap turns the newline into a hardBreak node, which is not
      // type "text", so the paragraph counted as non-empty and the
      // whitespace-only rule below never got to apply. Intermittent in
      // practice, because whether the input became a hardBreak or a
      // second empty paragraph depended on how the editor applied it.
      if (child.type === "hardBreak") return true;
      return (
        child.type === "text" && (!child.text || child.text.trim().length === 0)
      );
    });
  });
}
