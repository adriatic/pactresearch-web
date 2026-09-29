import { docToContentSegments } from "./promptContentToMarkdownBlocks";
import type { RichContent } from "./richContent";

// Task 65. Turns a stored prompt into the markdown that goes into an
// exported discussion.
//
// Two sources, and which one is used matters. responses.prompt_text is
// the FLATTENED plain text -- docToPlainText deliberately drops all
// formatting and turns a pasted image into the four characters
// "[image]". responses.prompt_content is the rich Tiptap document the
// user actually typed, with its bold, lists and code blocks intact.
//
// So prompt_content wins wherever it exists, exactly as History does
// (task 46 item B) -- otherwise a prompt would export with less
// formatting than the app shows for the same turn. prompt_text remains
// the fallback, and is still the normal path for older rows: most
// production rows predate that column.
//
// Images become a placeholder rather than a markdown image. Their src is
// this app's own /api/prompt-images route, which requires the caller's
// session -- a real image link would be a broken image for every reader
// the export is actually FOR. A marker is honest; a 401 is not.
export function promptToMarkdown(
  promptContent: RichContent | null,
  promptText: string,
): string {
  if (!promptContent) return promptText.trim();

  const segments = docToContentSegments(promptContent);
  if (segments.length === 0) return promptText.trim();

  return segments
    .map((segment) =>
      segment.type === "text"
        ? segment.text
        : segment.alt
          ? `_[image: ${segment.alt}]_`
          : "_[image]_",
    )
    .join("\n\n")
    .trim();
}
