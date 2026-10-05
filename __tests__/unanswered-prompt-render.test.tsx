import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";

// Task 77. Older PACT apps saved prompts that were never run, as cells
// with an empty response (195 of 295 cells in the older .pact files on
// record). Imported, each must read as "never run", not as a Response
// heading over nothing with a Continue button for a non-existent answer.

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

function entry(id: string, response: string | null) {
  return {
    id,
    prompt_text: `prompt ${id}`,
    prompt_content: null,
    response,
    resolved_model: null,
    created_at: new Date(2026, 6, 1).toISOString(),
  };
}

describe("an imported prompt that was never run", () => {
  test.each([
    ["empty", ""],
    ["whitespace", "  \n "],
    ["null", null],
  ])("a %s response says it was never run, with no Continue", (_, value) => {
    render(<DiscussionContent {...base} history={[entry("r1", value)]} />);
    expect(
      screen.getByText("No response — this prompt was never run."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    // The prompt itself is still shown.
    expect(document.body.textContent).toContain("prompt r1");
  });

  test("answered entries beside it are unchanged", () => {
    render(
      <DiscussionContent
        {...base}
        history={[entry("r1", ""), entry("r2", "a real answer")]}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Continue" })).toHaveLength(1);
    expect(document.body.textContent).toContain("a real answer");
  });
});
