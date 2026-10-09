import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";

// Task 71. The quiet note under an answer whose request left out the
// oldest turns -- shown only when that happened.

afterEach(cleanup);

const base = {
  discussionId: "d1",
  streamedResponse: null,
  streamedResponseCreatedAt: null,
  isStreaming: false,
  isRunning: false,
  onContinue: () => {},
  executionError: null,
};

function entry(id: string, turnsLeftOut?: number) {
  return {
    id,
    prompt_text: `prompt ${id}`,
    prompt_content: null,
    response: `answer ${id}`,
    resolved_model: "m",
    created_at: new Date().toISOString(),
    turns_left_out: turnsLeftOut,
  };
}

describe("the left-out note", () => {
  test("appears under the answer whose request left turns out, and nowhere else", () => {
    render(
      <DiscussionContent {...base} history={[entry("old"), entry("new", 3)]} />,
    );
    const notes = document.querySelectorAll("[data-history-left-out]");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(
      "To fit the model's size limit, this answer did not see the 3 oldest turns of this discussion. They are still saved here and in exports.",
    );
    // Directly after the newest answer, before its Continue button.
    expect(notes[0].previousElementSibling?.textContent).toContain(
      "answer new",
    );
  });

  test("an ordinary discussion shows no note at all", () => {
    render(
      <DiscussionContent {...base} history={[entry("a", 0), entry("b")]} />,
    );
    expect(document.querySelectorAll("[data-history-left-out]")).toHaveLength(
      0,
    );
  });
});
