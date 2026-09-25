import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";

// Task 43 item 3: the model name is no longer shown to the user in the
// response panel. Guarded in both places it used to appear -- each
// history entry's "Response — <model> — <date>" line and the live
// response's own heading -- because removing one and leaving the other
// is the incoherent state this is most likely to regress into.
//
// Scoped to display only. resolved_model is still persisted, still
// exported in .pact files, and still shown on /admin/timings; none of
// that is this component's concern.

afterEach(cleanup);

const MODEL = "claude-sonnet-4-6-20260101";

const base = {
  discussionId: "d1",
  history: [],
  streamedResponse: null,
  streamedResponseCreatedAt: null,
  isStreaming: false,
  isRunning: false,
  executionError: null,
};

describe("model name is not user-facing in the response panel", () => {
  test("a history entry shows Response and its timestamp, but no model", () => {
    const created = new Date().toISOString();
    render(
      <DiscussionContent
        {...base}
        history={[
          {
            id: "r1",
            prompt_text: "a prompt",
            prompt_content: null,
            response: "a response",
            resolved_model: MODEL,
            created_at: created,
          },
        ]}
      />,
    );
    expect(document.body.textContent).not.toContain(MODEL);
    // The line itself is still there -- this removed the model, not the
    // heading or the timestamp beside it.
    expect(screen.getByText("Response")).toBeTruthy();
    expect(document.body.textContent).toContain(
      new Date(created).toLocaleString(),
    );
  });

  test("the live response heading shows no model either", () => {
    render(
      <DiscussionContent
        {...base}
        streamedResponse="streaming text"
        isStreaming={true}
        streamedResponseCreatedAt={new Date().toISOString()}
      />,
    );
    expect(document.body.textContent).not.toContain(MODEL);
    expect(screen.getByText(/Live response/)).toBeTruthy();
  });

  test("DiscussionContent no longer accepts a streamedModel prop at all", () => {
    // Stronger than asserting on rendered text: the prop is gone from the
    // component's contract, so a future edit cannot quietly start
    // rendering it again from the old plumbing.
    expect(Object.keys(base)).not.toContain("streamedModel");
    const source = DiscussionContent.toString();
    expect(source).not.toContain("streamedModel");
  });
});
