import { describe, expect, test } from "vitest";
import { promptToMarkdown } from "@/lib/discussionPromptMarkdown";
import { plainTextToDoc } from "@/lib/richContent";

describe("which source a prompt is exported from", () => {
  test("a row with no prompt_content falls back to prompt_text", () => {
    expect(promptToMarkdown(null, "  what is entropy?  ")).toBe(
      "what is entropy?",
    );
  });

  // The reason prompt_content wins: prompt_text is the FLATTENED form.
  // Exporting from it would silently drop formatting the app displays.
  test("prompt_content wins, and keeps formatting prompt_text had lost", () => {
    const rich = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Compare " },
            { type: "text", text: "energy", marks: [{ type: "bold" }] },
            { type: "text", text: " and momentum." },
          ],
        },
      ],
    };
    expect(promptToMarkdown(rich, "Compare energy and momentum.")).toBe(
      "Compare **energy** and momentum.",
    );
  });

  test("a rich prompt's list and code block survive", () => {
    const rich = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    const markdown = promptToMarkdown(rich, "one two const x = 1;");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("- two");
    expect(markdown).toContain("```js\nconst x = 1;\n```");
  });

  test("a legacy plain-text doc round-trips to the same text", () => {
    expect(promptToMarkdown(plainTextToDoc("line one\nline two"), "")).toBe(
      "line one\n\nline two",
    );
  });
});

describe("images", () => {
  // Their src points at this app's own authenticated /api/prompt-images
  // route, so a markdown image link would be a broken image for exactly
  // the reader the export exists for.
  test("an image becomes a marker, not a link that would 404", () => {
    const rich = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "see this:" }] },
        {
          type: "image",
          attrs: { src: "/api/prompt-images/abc/def.png", alt: null },
        },
      ],
    };
    const markdown = promptToMarkdown(rich, "see this: [image]");
    expect(markdown).toBe("see this:\n\n_[image]_");
    expect(markdown).not.toContain("/api/prompt-images");
    expect(markdown).not.toContain("![");
  });

  test("alt text is kept when there is any", () => {
    const rich = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "/api/prompt-images/a/b.png", alt: "the apparatus" },
        },
      ],
    };
    expect(promptToMarkdown(rich, "[image]")).toBe("_[image: the apparatus]_");
  });
});

describe("empty prompts", () => {
  test("an empty rich doc falls back rather than exporting nothing", () => {
    const empty = { type: "doc", content: [{ type: "paragraph" }] };
    expect(promptToMarkdown(empty, "the real text")).toBe("the real text");
  });
});
