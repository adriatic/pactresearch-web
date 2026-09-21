import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { getSchema, type Extensions } from "@tiptap/core";

// The single source of truth for which Tiptap extensions this app uses --
// imported by both the live client editor (Composer.tsx, via useEditor)
// and the server-side schema builder below (promptContentToMarkdownBlocks.ts,
// which needs a real ProseMirror Schema to turn a discussion's stored JSON
// back into walkable nodes, without ever mounting a live editor). Sharing
// this one list is what guarantees the two can never drift apart -- a node
// or mark type the client can produce that the server doesn't know how to
// read back would otherwise be a real, silent risk.
export function tiptapExtensions(): Extensions {
  return [StarterKit, Image];
}

let cachedSchema: ReturnType<typeof getSchema> | null = null;

// getSchema() does real work (resolving/sorting every extension) -- cheap
// enough to not matter per-request, but there's no reason to redo it on
// every single /api/execute call either, so it's memoized at module scope.
export function getServerSchema() {
  if (!cachedSchema) {
    cachedSchema = getSchema(tiptapExtensions());
  }
  return cachedSchema;
}
