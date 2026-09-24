// @vitest-environment node
import { describe, expect, test } from "vitest";
import { docToContentSegments } from "@/lib/promptContentToMarkdownBlocks";
import {
  plainTextToDoc,
  isEmptyDoc,
  docToPlainText,
  EMPTY_DOC,
} from "@/lib/richContent";
import type { RichContent } from "@/lib/richContent";

function doc(...content: RichContent[]): RichContent {
  return { type: "doc", content };
}
function p(...content: RichContent[]): RichContent {
  return { type: "paragraph", content };
}
function text(
  t: string,
  marks?: { type: string; attrs?: Record<string, unknown> }[],
): RichContent {
  return marks ? { type: "text", text: t, marks } : { type: "text", text: t };
}

describe("docToContentSegments", () => {
  test("a single plain paragraph becomes one text segment", () => {
    const segments = docToContentSegments(doc(p(text("Hello there."))));
    expect(segments).toEqual([{ type: "text", text: "Hello there." }]);
  });

  test("bold/italic/strike marks convert to inline Markdown", () => {
    const segments = docToContentSegments(
      doc(
        p(
          text("plain "),
          text("bold", [{ type: "bold" }]),
          text(" "),
          text("italic", [{ type: "italic" }]),
          text(" "),
          text("struck", [{ type: "strike" }]),
        ),
      ),
    );
    expect(segments).toEqual([
      { type: "text", text: "plain **bold** *italic* ~~struck~~" },
    ]);
  });

  test("an image between two paragraphs produces three ordered segments", () => {
    const segments = docToContentSegments(
      doc(
        p(text("Before the image.")),
        { type: "image", attrs: { src: "user/disc/abc.png", alt: "a cat" } },
        p(text("After the image.")),
      ),
    );
    expect(segments).toEqual([
      { type: "text", text: "Before the image." },
      { type: "image", src: "user/disc/abc.png", alt: "a cat" },
      { type: "text", text: "After the image." },
    ]);
  });

  test("two consecutive images with no text between them produce two adjacent image segments, no empty text segment", () => {
    const segments = docToContentSegments(
      doc(
        { type: "image", attrs: { src: "a.png", alt: null } },
        { type: "image", attrs: { src: "b.png", alt: null } },
      ),
    );
    expect(segments).toEqual([
      { type: "image", src: "a.png", alt: null },
      { type: "image", src: "b.png", alt: null },
    ]);
  });

  test("an image-only doc with no text at all produces just the image segment", () => {
    const segments = docToContentSegments(
      doc({ type: "image", attrs: { src: "only.png", alt: null } }),
    );
    expect(segments).toEqual([{ type: "image", src: "only.png", alt: null }]);
  });

  test("two consecutive paragraphs are grouped into one text segment with a blank line between them, not two segments", () => {
    const segments = docToContentSegments(
      doc(p(text("First paragraph.")), p(text("Second paragraph."))),
    );
    expect(segments).toEqual([
      { type: "text", text: "First paragraph.\n\nSecond paragraph." },
    ]);
  });

  test("headings, bullet lists, and blockquotes render as their own Markdown syntax", () => {
    const segments = docToContentSegments(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("A heading")] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(text("first"))] },
            { type: "listItem", content: [p(text("second"))] },
          ],
        },
        { type: "blockquote", content: [p(text("a quote"))] },
      ),
    );
    expect(segments).toHaveLength(1);
    const combined = (segments[0] as { text: string }).text;
    expect(combined).toContain("## A heading");
    expect(combined).toContain("- first");
    expect(combined).toContain("- second");
    expect(combined).toContain("> a quote");
  });

  test("an empty doc produces zero segments", () => {
    const segments = docToContentSegments(EMPTY_DOC);
    expect(segments).toEqual([]);
  });

  // Task 36 follow-up: StarterKit v3.31.3 includes Link by default, but
  // this serializer's marks map had no entry for it at all, so a prompt
  // containing a link-marked text node hit MarkdownSerializer's own
  // unhandled-mark throw -- surfaced to real users as "Execution failed",
  // confirmed via the exact error id in Vercel's production logs.
  test("a link mark renders as Markdown link syntax", () => {
    const segments = docToContentSegments(
      doc(
        p(
          text("see "),
          text("this page", [
            { type: "link", attrs: { href: "https://example.com/x" } },
          ]),
          text(" for details"),
        ),
      ),
    );
    expect(segments).toEqual([
      {
        type: "text",
        text: "see [this page](https://example.com/x) for details",
      },
    ]);
  });

  test("a bare-URL link (text equals its own href) renders as an autolink", () => {
    const segments = docToContentSegments(
      doc(
        p(
          text("https://example.com/x", [
            { type: "link", attrs: { href: "https://example.com/x" } },
          ]),
        ),
      ),
    );
    expect(segments).toEqual([
      { type: "text", text: "<https://example.com/x>" },
    ]);
  });

  test("a link with a title attribute renders the title, not an autolink", () => {
    const segments = docToContentSegments(
      doc(
        p(
          text("link", [
            {
              type: "link",
              attrs: { href: "https://example.com/x", title: "A title" },
            },
          ]),
        ),
      ),
    );
    expect(segments).toEqual([
      { type: "text", text: '[link](https://example.com/x "A title")' },
    ]);
  });
});

describe("plainTextToDoc / isEmptyDoc backward-compat helpers", () => {
  test("plainTextToDoc round-trips through docToContentSegments back to the same plain text", () => {
    const segments = docToContentSegments(plainTextToDoc("just plain text"));
    expect(segments).toEqual([{ type: "text", text: "just plain text" }]);
  });

  test("plainTextToDoc splits multi-line text into separate paragraphs", () => {
    const segments = docToContentSegments(plainTextToDoc("line one\nline two"));
    expect(segments).toEqual([{ type: "text", text: "line one\n\nline two" }]);
  });

  test("isEmptyDoc is true for EMPTY_DOC and for a doc with only whitespace", () => {
    expect(isEmptyDoc(EMPTY_DOC)).toBe(true);
    expect(isEmptyDoc(doc(p(text("   "))))).toBe(true);
    expect(isEmptyDoc(null)).toBe(true);
    expect(isEmptyDoc(undefined)).toBe(true);
  });

  test("isEmptyDoc is false for real text, and false for an image-only doc", () => {
    expect(isEmptyDoc(doc(p(text("real content"))))).toBe(false);
    expect(
      isEmptyDoc(doc({ type: "image", attrs: { src: "x.png", alt: null } })),
    ).toBe(false);
  });
});

describe("docToPlainText", () => {
  test("strips formatting marks entirely -- no Markdown syntax, unlike docToContentSegments", () => {
    const result = docToPlainText(
      doc(p(text("plain "), text("bold", [{ type: "bold" }]), text(" text"))),
    );
    expect(result).toBe("plain bold text");
  });

  test("joins multiple paragraphs with a blank line, same as the Markdown path", () => {
    const result = docToPlainText(doc(p(text("first")), p(text("second"))));
    expect(result).toBe("first\n\nsecond");
  });

  test("an image becomes a [image] placeholder, not silently dropped", () => {
    const result = docToPlainText(
      doc(
        p(text("before")),
        { type: "image", attrs: { src: "x.png", alt: null } },
        p(text("after")),
      ),
    );
    expect(result).toBe("before\n\n[image]\n\nafter");
  });
});
