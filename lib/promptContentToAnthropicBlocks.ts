import type { SupabaseClient } from "@supabase/supabase-js";
import { docToContentSegments } from "./promptContentToMarkdownBlocks";
import { storagePathFromPromptImageSrc } from "./promptImagePath";
import type { RichContent } from "./richContent";

// Anthropic Messages API content-block shapes -- only the two this app
// actually produces (text, base64 image). Sent directly in place of the
// old plain-string `content`, via the same raw fetch() this app has
// always used to call Anthropic (no SDK dependency).
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

// Matches the bucket's own allowed_mime_types (prompt-images storage
// migration) -- the extension an image was uploaded under is how its MIME
// type is recovered here, rather than storing a redundant attribute on
// the Tiptap image node itself.
const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function mimeTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_MIME_TYPE[ext] ?? "application/octet-stream";
}

// Converts a discussion's stored/submitted rich content into Anthropic's
// multimodal content-block array. The text/image splitting and Markdown
// formatting is docToContentSegments' own pure job (see that file); this
// function's only added responsibility is the actual I/O -- fetching each
// image's real bytes from the prompt-images bucket via the session-scoped
// client (so RLS naturally confines this to the caller's own images, the
// same access boundary as everything else in this app) and base64-encoding
// them for the request body.
export async function promptContentToAnthropicBlocks(
  content: RichContent,
  supabase: SupabaseClient,
): Promise<AnthropicContentBlock[]> {
  const segments = docToContentSegments(content);

  const blocks: AnthropicContentBlock[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      blocks.push({ type: "text", text: segment.text });
      continue;
    }

    const storagePath = storagePathFromPromptImageSrc(segment.src);
    if (!storagePath) {
      throw new Error(
        `Image src "${segment.src}" is not a recognized prompt-images reference.`,
      );
    }

    const { data, error } = await supabase.storage
      .from("prompt-images")
      .download(storagePath);
    if (error || !data) {
      throw new Error(
        `Failed to fetch prompt image "${storagePath}" from storage: ${error?.message ?? "no data returned"}`,
      );
    }
    const arrayBuffer = await data.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeTypeForPath(storagePath),
        data: base64,
      },
    });
  }

  return blocks;
}
