import { Node, Fragment, Mark } from "@tiptap/pm/model";
import {
  MarkdownSerializer,
  MarkdownSerializerState,
} from "prosemirror-markdown";
import { getServerSchema } from "./tiptapExtensions";
import type { RichContent } from "./richContent";

// Turns stored Tiptap/ProseMirror JSON into an ordered list of text/image
// segments, ready to become Anthropic multimodal content blocks
// (lib/promptContentToAnthropicBlocks.ts adds the actual image-byte
// fetch on top of this -- this file is the pure, no-I/O half, kept
// separate specifically so it's independently unit-testable).
//
// Text formatting uses prosemirror-markdown directly (actively maintained
// by the ProseMirror project itself, published the same day this was
// written) rather than the community `tiptap-markdown` package (its own
// last release predates this by over a year) or Tiptap v3's own newer
// `markdown`/`createBlockMarkdownSpec` exports (those appear aimed at
// *parsing* custom markdown syntax into editor nodes for input rules --
// no `generateMarkdown` counterpart to `generateHTML`/`generateText`
// exists, so there's no equivalent first-party doc-to-markdown serializer
// to reach for instead). prosemirror-markdown's own default node/mark
// keys are snake_case (bullet_list, code_block, hard_break...) --
// StarterKit's are camelCase (bulletList, codeBlock, hardBreak...) -- the
// map below is the small adapter that bridges that, reusing the default
// serializer's own function bodies under Tiptap's real key names rather
// than re-deriving the formatting logic itself.
export interface TextSegment {
  type: "text";
  text: string;
}

export interface ImageSegment {
  type: "image";
  src: string;
  alt: string | null;
}

export type ContentSegment = TextSegment | ImageSegment;

const markdownSerializer = new MarkdownSerializer(
  {
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(state.repeat("#", node.attrs.level) + " ");
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    horizontalRule(state, node) {
      state.write(node.attrs.markup || "---");
      state.closeBlock(node);
    },
    bulletList(state, node) {
      state.renderList(node, "  ", () => (node.attrs.bullet || "-") + " ");
    },
    orderedList(state, node) {
      const start = node.attrs.start ?? 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxW + 2);
      state.renderList(node, space, (i) => {
        const nStr = String(start + i);
        return state.repeat(" ", maxW - nStr.length) + nStr + ". ";
      });
    },
    listItem(state, node) {
      state.renderContent(node);
    },
    codeBlock(state, node) {
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
      state.write(fence + (node.attrs.language || "") + "\n");
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state, node) {
      state.text(node.text ?? "", true);
    },
  },
  {
    bold: {
      open: "**",
      close: "**",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    italic: {
      open: "*",
      close: "*",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    // GFM strikethrough -- not part of prosemirror-markdown's own default
    // mark set at all (it has no strike concept out of the box), added
    // here since StarterKit includes the Strike mark.
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    code: {
      open(_state, _mark, parent, index) {
        return backticksFor(parent.child(index), -1);
      },
      close(_state, _mark, parent, index) {
        return backticksFor(parent.child(index - 1), 1);
      },
      escape: false,
    },
    // StarterKit v3.31.3 includes Link by default (confirmed via
    // node_modules/@tiptap/starter-kit/dist/index.d.ts) -- this map
    // previously had no entry for it at all, so any prompt content with a
    // link-marked text node hit MarkdownSerializer's own "Mark type
    // `link` not supported by Markdown renderer" throw, surfacing to
    // users as a generic "Execution failed" error (task 36 follow-up,
    // confirmed via the exact error id in Vercel's logs). Logic copied
    // verbatim from prosemirror-markdown's own defaultMarkdownSerializer
    // (node_modules/prosemirror-markdown/dist/index.js) rather than
    // reinvented, including the bare-URL "<...>" autolink shorthand.
    link: {
      open(
        state: MarkdownSerializerState,
        mark: Mark,
        parent: Node,
        index: number,
      ) {
        // inAutolink isn't part of MarkdownSerializerState's public type,
        // but prosemirror-markdown's own default link serializer stashes
        // it directly on the (single, per-serialize-call, purely
        // synchronous) state instance to pass data from open() to
        // close() -- reusing that exact mechanism rather than inventing a
        // parallel one.
        const stateAny = state as MarkdownSerializerState & {
          inAutolink?: boolean;
        };
        stateAny.inAutolink = isPlainURL(mark, parent, index);
        return stateAny.inAutolink ? "<" : "[";
      },
      close(state: MarkdownSerializerState, mark: Mark) {
        const stateAny = state as MarkdownSerializerState & {
          inAutolink?: boolean;
        };
        const { inAutolink } = stateAny;
        stateAny.inAutolink = undefined;
        return inAutolink
          ? ">"
          : "](" +
              String(mark.attrs.href).replace(/[()"]/g, "\\$&") +
              (mark.attrs.title
                ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"`
                : "") +
              ")";
      },
      mixable: true,
    },
  },
);

// Copied from prosemirror-markdown's own (unexported) helper -- an
// autolink ("<https://...>") is only correct when the link text is
// exactly its own href with no title and no other overlapping mark, and
// only extends to the end of the run or up to whatever follows without
// this same link mark.
function isPlainURL(link: Mark, parent: Node, index: number): boolean {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (
    !content.isText ||
    content.text !== link.attrs.href ||
    content.marks[content.marks.length - 1] !== link
  ) {
    return false;
  }
  return (
    index === parent.childCount - 1 ||
    !link.isInSet(parent.child(index + 1).marks)
  );
}

// Copied from prosemirror-markdown's own (unexported) helper -- picks a
// backtick run one longer than any already inside the code span, so
// inline code containing a literal backtick still round-trips correctly.
function backticksFor(node: Node, side: number) {
  const ticks = /`+/g;
  let m;
  let len = 0;
  if (node.isText) {
    while ((m = ticks.exec(node.text ?? ""))) len = Math.max(len, m[0].length);
  }
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

// image is deliberately NOT in the node map above -- @tiptap/extension-image
// registers its node as block-level (inline: false), so an image is
// always its own top-level entry in doc.content, never nested inside a
// paragraph's inline content. That means splitting text from images is a
// single pass over doc.content, not a text-splicing problem -- each
// top-level node is either an image (its own segment) or something the
// markdown serializer above can render (grouped with its consecutive
// non-image neighbors into one text segment, so block-level spacing
// between e.g. two paragraphs is still the serializer's own, not
// hand-reconstructed).
export function docToContentSegments(doc: RichContent): ContentSegment[] {
  const schema = getServerSchema();
  const docNode = Node.fromJSON(schema, doc as Record<string, unknown>);

  const segments: ContentSegment[] = [];
  let pendingRun: Node[] = [];

  function flushRun() {
    if (pendingRun.length === 0) return;
    const runDoc = schema.topNodeType.create(null, Fragment.from(pendingRun));
    const text = markdownSerializer.serialize(runDoc).trim();
    if (text.length > 0) {
      segments.push({ type: "text", text });
    }
    pendingRun = [];
  }

  docNode.forEach((node) => {
    if (node.type.name === "image") {
      flushRun();
      segments.push({
        type: "image",
        src: String(node.attrs.src),
        alt: node.attrs.alt ?? null,
      });
    } else {
      pendingRun.push(node);
    }
  });
  flushRun();

  return segments;
}
