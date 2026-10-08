import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  historyToAnthropicMessages,
  IMAGE_MISSING_NOTE,
  IMAGE_OMITTED_NOTE,
  MAX_IMAGE_BYTES_PER_REQUEST,
  MAX_IMAGES_PER_REQUEST,
  type PriorTurn,
} from "@/lib/discussionHistory";
import type { RichContent } from "@/lib/richContent";

// Task 69. Earlier turns' images are carried forward. The storage client
// is a stand-in that records which images were fetched; the integration
// test (execute-route) covers the real bucket.

function fakeStorage(files: Record<string, string>) {
  const fetched: string[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          expect(bucket).toBe("prompt-images");
          fetched.push(path);
          if (!(path in files)) {
            return { data: null, error: { message: "Object not found" } };
          }
          return { data: new Blob([files[path]]), error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, fetched };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

function textTurn(prompt: string, response: string): PriorTurn {
  return {
    prompt_text: prompt,
    prompt_content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: prompt }] },
      ],
    },
    response,
  };
}

function imageTurn(
  before: string,
  paths: string[],
  response: string,
): PriorTurn {
  const content: RichContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: before }] },
      ...paths.map((p) => ({
        type: "image",
        attrs: { src: `/api/prompt-images/${p}`, alt: p },
      })),
    ],
  };
  return { prompt_text: before, prompt_content: content, response };
}

describe("historyToAnthropicMessages", () => {
  test("a discussion without images is sent exactly as before, and storage is never touched", async () => {
    const { client, fetched } = fakeStorage({});
    const { messages, stats } = await historyToAnthropicMessages(
      [
        textTurn("Who was Tesla?", "An inventor."),
        {
          prompt_text: "Old row, no rich content",
          prompt_content: null,
          response: "Yes.",
        },
      ],
      client,
    );
    expect(messages).toEqual([
      { role: "user", content: "Who was Tesla?" },
      { role: "assistant", content: "An inventor." },
      { role: "user", content: "Old row, no rich content" },
      { role: "assistant", content: "Yes." },
    ]);
    expect(fetched).toEqual([]);
    expect(stats.imagesSent).toBe(0);
  });

  test("an earlier turn's image is sent as an image block, in its place among the text", async () => {
    const { client } = fakeStorage({ "u/d/cat.png": "CATBYTES" });
    const { messages, stats } = await historyToAnthropicMessages(
      [imageTurn("What is in this picture?", ["u/d/cat.png"], "A cat.")],
      client,
    );
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is in this picture?" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: b64("CATBYTES"),
          },
        },
      ],
    });
    expect(messages[1]).toEqual({ role: "assistant", content: "A cat." });
    expect(stats.imagesSent).toBe(1);
  });

  test("several image turns keep every image, in order, alongside text-only turns", async () => {
    const { client } = fakeStorage({
      "u/d/a.png": "A",
      "u/d/b.jpg": "B",
      "u/d/c.webp": "C",
    });
    const { messages } = await historyToAnthropicMessages(
      [
        imageTurn("first", ["u/d/a.png"], "r1"),
        textTurn("no picture here", "r2"),
        imageTurn("third", ["u/d/b.jpg", "u/d/c.webp"], "r3"),
      ],
      client,
    );
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const images = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "image")
      .map((b) =>
        b.type === "image" ? [b.source.media_type, b.source.data] : [],
      );
    expect(images).toEqual([
      ["image/png", b64("A")],
      ["image/jpeg", b64("B")],
      ["image/webp", b64("C")],
    ]);
    expect(messages[2].content).toBe("no picture here");
  });

  test("incomplete turns are still dropped (Task 62)", async () => {
    const { client, fetched } = fakeStorage({ "u/d/a.png": "A" });
    const { messages } = await historyToAnthropicMessages(
      [imageTurn("failed run", ["u/d/a.png"], ""), textTurn("ok", "fine")],
      client,
    );
    expect(messages).toEqual([
      { role: "user", content: "ok" },
      { role: "assistant", content: "fine" },
    ]);
    expect(fetched).toEqual([]);
  });

  test("past the image count limit, the newest images are kept and older ones become a note, unfetched", async () => {
    const { client, fetched } = fakeStorage({
      "u/d/old.png": "O",
      "u/d/mid.png": "M",
      "u/d/new.png": "N",
    });
    // The current turn already holds all but two of the allowed images.
    const { messages, stats } = await historyToAnthropicMessages(
      [
        imageTurn("oldest", ["u/d/old.png"], "r1"),
        imageTurn("middle", ["u/d/mid.png"], "r2"),
        imageTurn("newest", ["u/d/new.png"], "r3"),
      ],
      client,
      { count: MAX_IMAGES_PER_REQUEST - 2, bytes: 0 },
    );
    expect(stats).toMatchObject({ imagesSent: 2, imagesOmittedForSize: 1 });
    expect(fetched).not.toContain("u/d/old.png");
    expect(messages[0].content).toEqual([
      { type: "text", text: "oldest" },
      { type: "text", text: IMAGE_OMITTED_NOTE },
    ]);
    expect((messages[2].content as { type: string }[])[1].type).toBe("image");
    expect((messages[4].content as { type: string }[])[1].type).toBe("image");
  });

  test("past the size limit, the newest images are kept and older ones become a note", async () => {
    const { client, fetched } = fakeStorage({
      "u/d/old.png": "OLD-IMAGE",
      "u/d/new.png": "NEW",
    });
    const newSize = b64("NEW").length;
    const { messages, stats } = await historyToAnthropicMessages(
      [
        imageTurn("oldest", ["u/d/old.png"], "r1"),
        imageTurn("newest", ["u/d/new.png"], "r2"),
      ],
      client,
      // Room for the newest image and not one byte more.
      { count: 0, bytes: MAX_IMAGE_BYTES_PER_REQUEST - newSize },
    );
    expect(stats).toMatchObject({ imagesSent: 1, imagesOmittedForSize: 1 });
    expect((messages[2].content as { type: string }[])[1].type).toBe("image");
    expect(messages[0].content).toEqual([
      { type: "text", text: "oldest" },
      { type: "text", text: IMAGE_OMITTED_NOTE },
    ]);
    expect(fetched).toEqual(["u/d/new.png", "u/d/old.png"]);
  });

  test("an earlier image that is no longer stored becomes a note instead of failing the run", async () => {
    const { client } = fakeStorage({ "u/d/kept.png": "K" });
    const { messages, stats } = await historyToAnthropicMessages(
      [imageTurn("two pictures", ["u/d/gone.png", "u/d/kept.png"], "r1")],
      client,
    );
    expect(stats).toMatchObject({ imagesSent: 1, imagesMissing: 1 });
    expect(messages[0].content).toEqual([
      { type: "text", text: "two pictures" },
      { type: "text", text: IMAGE_MISSING_NOTE },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64("K") },
      },
    ]);
  });
});
