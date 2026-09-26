import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";
import type { RichContent } from "@/lib/richContent";

// Task 46 item B. The panel renders responses.prompt_content, so a pasted
// image shows as an image rather than the literal text "[image]" that
// docToPlainText produces for prompt_text.
//
// Two of these guard the NON-regression half, which matters more than the
// image case: plain prompts are almost all of the history, and rows older
// than the prompt_content column (most of production) have none at all.

afterEach(cleanup);

const base = {
  discussionId: "d1",
  streamedResponse: null,
  streamedResponseCreatedAt: null,
  isStreaming: false,
  isRunning: false,
  executionError: null,
};

function entry(overrides: {
  prompt_text: string;
  prompt_content: RichContent | null;
}) {
  return {
    id: "r1",
    response: "a response",
    resolved_model: "m",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const textDoc: RichContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const imageDoc: RichContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "look at this" }] },
    {
      type: "image",
      attrs: { src: "/api/prompt-images/d1/cat.png", alt: "cat.png" },
    },
  ],
};

describe("prompt rendering in the response panel", () => {
  test("a pasted image renders as an image, not the [image] placeholder", () => {
    render(
      <DiscussionContent
        {...base}
        history={[
          entry({
            prompt_text: "look at this\n\n[image]",
            prompt_content: imageDoc,
          }),
        ]}
      />,
    );
    const img = document.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/api/prompt-images/d1/cat.png");
    expect(img.getAttribute("alt")).toBe("cat.png");
    expect(document.body.textContent).not.toContain("[image]");
    expect(document.body.textContent).toContain("look at this");
  });

  test("a plain-text prompt still renders inline after the label, unchanged", () => {
    const { container } = render(
      <DiscussionContent
        {...base}
        history={[entry({ prompt_text: "hello", prompt_content: textDoc })]}
      />,
    );
    // The whole point of simpleTextOf: one <p> reading "Prompt: hello",
    // not a label followed by a separate block.
    const paras = Array.from(container.querySelectorAll("p")).map(
      (p) => p.textContent,
    );
    expect(paras).toContain("Prompt: hello");
    expect(container.querySelector("img")).toBeNull();
  });

  test("a row with no prompt_content falls back to prompt_text", () => {
    // The normal path for existing production rows, which predate the
    // column entirely.
    const { container } = render(
      <DiscussionContent
        {...base}
        history={[
          entry({ prompt_text: "legacy prompt", prompt_content: null }),
        ]}
      />,
    );
    const paras = Array.from(container.querySelectorAll("p")).map(
      (p) => p.textContent,
    );
    expect(paras).toContain("Prompt: legacy prompt");
  });

  test("formatting in a prompt survives, and headings cannot outrank the page", () => {
    const doc: RichContent = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and plain" },
          ],
        },
      ],
    };
    render(
      <DiscussionContent
        {...base}
        history={[
          entry({
            prompt_text: "Title\n\nbold and plain",
            prompt_content: doc,
          }),
        ]}
      />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    // level 1 is offset to h3 so a prompt cannot introduce an <h1>.
    expect(document.querySelector("h1")).toBeNull();
    expect(screen.getByText("Title").tagName).toBe("H3");
  });
});
