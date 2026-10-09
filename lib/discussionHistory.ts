import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchPromptImageBlock,
  type AnthropicContentBlock,
} from "./promptContentToAnthropicBlocks";
import { docToContentSegments } from "./promptContentToMarkdownBlocks";
import type { RichContent } from "./richContent";
import { newestTurnsWithinBudget } from "./historyBudget";

// Task 69. A discussion's earlier turns as Anthropic messages, images
// included.
//
// Task 62 carried prior turns forward as prompt_text only, so an image
// attached two turns ago never reached the model again ("what did you
// think of that screenshot?" had nothing to look at). Each responses row
// already keeps the full prompt in prompt_content, and its images stay in
// the prompt-images bucket until the discussion is deleted
// (lib/promptImagesCleanup.ts), so nothing new is stored.
//
// A turn WITH images is sent the way the current turn is: interleaved
// text and image blocks, built from the same segments and the same image
// fetch (promptContentToAnthropicBlocks.ts). A turn WITHOUT images is sent
// exactly as Task 62 sent it -- the prompt_text string -- so a discussion
// with no images makes the same request as before and never touches
// storage.
//
// Size. An image costs roughly (width x height) / 750 input tokens on
// every later turn, about 1,600 for a full-size screenshot, and its bytes
// travel base64-encoded (a third larger) in every request. Anthropic
// refuses a request over 32 MB, and is stricter about image dimensions
// once a request holds more than 20 images. Rather than let a long,
// image-heavy discussion fail on every later run, the NEWEST images are
// kept within the limits below, and older ones are replaced by a short
// note saying an image was there. The current turn's own images are
// always sent, as before, and count against the same limits first. This
// is a safety net, not the history cap: Task 71 should count these
// images when it budgets the whole history.

export const MAX_IMAGES_PER_REQUEST = 20;
// Base64 characters, i.e. bytes on the wire. 24 MB leaves room under
// Anthropic's 32 MB for the text, the system prompt and the JSON itself.
export const MAX_IMAGE_BYTES_PER_REQUEST = 24 * 1024 * 1024;

export const IMAGE_OMITTED_NOTE =
  "[An image was attached here. It was left out of this request to keep it within the size limit.]";
export const IMAGE_MISSING_NOTE =
  "[An image was attached here, but it is no longer stored.]";

export interface PriorTurn {
  prompt_text: string | null;
  prompt_content: RichContent | null;
  response: string | null;
}

export type HistoryMessage =
  | { role: "user"; content: string | AnthropicContentBlock[] }
  | { role: "assistant"; content: string };

export interface HistoryStats {
  // Task 71: completed turns sent, and the oldest ones left out of this
  // request to fit the model's window (still stored, still exported).
  turnsSent: number;
  turnsLeftOut: number;
  imagesSent: number;
  imageBytesSent: number;
  imagesOmittedForSize: number;
  imagesMissing: number;
}

export function countImageBlocks(blocks: AnthropicContentBlock[]): {
  count: number;
  bytes: number;
} {
  let count = 0;
  let bytes = 0;
  for (const block of blocks) {
    if (block.type === "image") {
      count += 1;
      bytes += block.source.data.length;
    }
  }
  return { count, bytes };
}

// Images are always top-level nodes (see docToContentSegments), so a
// shallow look is enough -- a turn without images costs no parsing.
function hasImage(content: RichContent | null): boolean {
  const nodes = (content as { content?: { type?: string }[] } | null)?.content;
  return Array.isArray(nodes) && nodes.some((node) => node?.type === "image");
}

// `used` is what the current turn already takes from the limits.
// `tokenBudget` (Task 71, lib/historyBudget.ts) is the room left for
// history; the oldest whole turns that do not fit are left out before
// any picture is fetched. Omitted, every completed turn is sent.
export async function historyToAnthropicMessages(
  turns: PriorTurn[],
  supabase: SupabaseClient,
  used: { count: number; bytes: number } = { count: 0, bytes: 0 },
  tokenBudget?: number,
): Promise<{ messages: HistoryMessage[]; stats: HistoryStats }> {
  // Only COMPLETED turns (Task 62): a row whose response is still null or
  // empty is an in-flight or failed run, and its prompt would put two
  // user messages back to back, which Anthropic rejects.
  const allComplete = turns.filter(
    (turn) =>
      (turn.prompt_text ?? "").trim().length > 0 &&
      (turn.response ?? "").trim().length > 0,
  );
  const { kept: complete, leftOut } =
    tokenBudget === undefined
      ? { kept: allComplete, leftOut: 0 }
      : newestTurnsWithinBudget(allComplete, tokenBudget);

  const stats: HistoryStats = {
    turnsSent: complete.length,
    turnsLeftOut: leftOut,
    imagesSent: 0,
    imageBytesSent: 0,
    imagesOmittedForSize: 0,
    imagesMissing: 0,
  };
  let count = used.count;
  let bytes = used.bytes;
  let full = false;

  // Built newest-first so the newest images win the budget; once one
  // does not fit, every older image is left out without being fetched,
  // so what reaches the model is always an unbroken recent run.
  const userContents: (string | AnthropicContentBlock[])[] = new Array(
    complete.length,
  );
  for (let i = complete.length - 1; i >= 0; i--) {
    const turn = complete[i];
    if (!hasImage(turn.prompt_content)) {
      userContents[i] = turn.prompt_text as string;
      continue;
    }

    const segments = docToContentSegments(turn.prompt_content as RichContent);
    const blocks: AnthropicContentBlock[] = new Array(segments.length);
    for (let j = segments.length - 1; j >= 0; j--) {
      const segment = segments[j];
      if (segment.type === "text") {
        blocks[j] = { type: "text", text: segment.text };
        continue;
      }
      if (full || count >= MAX_IMAGES_PER_REQUEST) {
        full = true;
        stats.imagesOmittedForSize += 1;
        blocks[j] = { type: "text", text: IMAGE_OMITTED_NOTE };
        continue;
      }
      let image: AnthropicContentBlock;
      try {
        image = await fetchPromptImageBlock(segment.src, supabase);
      } catch (error) {
        // Unlike the current turn, where a missing image is an error the
        // user can act on, an earlier turn's image going missing (e.g. a
        // notebook imported from a .pact file whose images stayed with
        // the original) must not make every later run in the discussion
        // fail. Logged by path only, never content.
        console.warn(
          `[history] earlier prompt image unavailable: ${(error as Error).message}`,
        );
        stats.imagesMissing += 1;
        blocks[j] = { type: "text", text: IMAGE_MISSING_NOTE };
        continue;
      }
      const size = countImageBlocks([image]).bytes;
      if (bytes + size > MAX_IMAGE_BYTES_PER_REQUEST) {
        full = true;
        stats.imagesOmittedForSize += 1;
        blocks[j] = { type: "text", text: IMAGE_OMITTED_NOTE };
        continue;
      }
      count += 1;
      bytes += size;
      stats.imagesSent += 1;
      stats.imageBytesSent += size;
      blocks[j] = image;
    }
    userContents[i] = blocks;
  }

  const messages: HistoryMessage[] = complete.flatMap((turn, i) => [
    { role: "user" as const, content: userContents[i] },
    { role: "assistant" as const, content: turn.response as string },
  ]);
  return { messages, stats };
}
