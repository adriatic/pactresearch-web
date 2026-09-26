import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";

// Task 42 Part C. The indicator's whole job is "the app is alive during
// the pre-first-content wait", so what actually needs guarding is the
// boundary conditions -- when it appears and, more importantly, when it
// gets out of the way. The 2000ms write throttle means the visible-wait
// window is real and these transitions are user-facing.

const base = {
  discussionId: "d1",
  history: [],
  streamedResponse: null,
  streamedResponseCreatedAt: null,
  isStreaming: false,
  isRunning: false,
  onContinue: () => {},
  executionError: null,
};

// vitest.setup.ts registers MSW's hooks but no RTL cleanup, and the config
// does not enable `globals`, so @testing-library/react's auto-cleanup never
// runs -- renders accumulate across tests in a file. Existing suites happen
// not to trip this (they render once, or query uniquely); this one renders
// repeatedly and queries by role, so it has to clean up after itself.
afterEach(cleanup);

// Queried by class, not by role: the indicator is intentionally
// aria-hidden (ComposerHeader owns the live region -- see the component's
// own comment), so there is no role to query it by.
const indicator = () => document.querySelector(".pw-thinking");

describe("thinking indicator", () => {
  test("hidden when idle", () => {
    render(<DiscussionContent {...base} />);
    expect(indicator()).toBeNull();
  });

  test("shown while running with no content yet", () => {
    render(<DiscussionContent {...base} isRunning={true} />);
    expect(indicator()).not.toBeNull();
    expect(indicator()?.textContent).toContain("Thinking");
  });

  test("hidden as soon as the first content arrives, even mid-run", () => {
    // The critical transition: the first throttled write lands, isRunning
    // is still true, and the indicator must yield to the real content
    // rather than sitting above it.
    render(
      <DiscussionContent
        {...base}
        isRunning={true}
        streamedResponse="partial"
        isStreaming={true}
      />,
    );
    expect(indicator()).toBeNull();
    expect(screen.getByText("partial")).toBeTruthy();
  });

  test("hidden for an empty-string response, not just a non-null one", () => {
    // Guards the null check specifically: "" is content the stream has
    // opened, so the indicator's job is over.
    render(
      <DiscussionContent {...base} isRunning={true} streamedResponse="" />,
    );
    expect(indicator()).toBeNull();
  });

  test("does not linger after a failed run", () => {
    render(
      <DiscussionContent
        {...base}
        isRunning={false}
        executionError="Execution failed."
      />,
    );
    expect(indicator()).toBeNull();
    expect(screen.getByText("Execution failed.")).toBeTruthy();
  });

  test("shown above prior history, where the new response will land", () => {
    const { container } = render(
      <DiscussionContent
        {...base}
        isRunning={true}
        history={[
          {
            id: "r1",
            prompt_text: "earlier prompt",
            prompt_content: null,
            response: "earlier response",
            resolved_model: "claude-sonnet-4-6",
            created_at: new Date().toISOString(),
          },
        ]}
      />,
    );
    const status = indicator();
    expect(status).not.toBeNull();
    const earlier = screen.getByText("earlier response");
    // Indicator must come AFTER the history block in document order --
    // i.e. where the next response is about to render.
    expect(
      earlier.compareDocumentPosition(status!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });

  test("is hidden from assistive tech, leaving ComposerHeader's live region the single announcer", () => {
    // Regression guard for the collision this actually caused: a second
    // role="status" node broke task 39's report-a-problem spec and would
    // have made screen readers announce the same run twice.
    render(<DiscussionContent {...base} isRunning={true} />);
    expect(indicator()!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
