import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiscussionContent } from "@/app/DiscussionContent";
import { ComposerHeader } from "@/app/ComposerHeader";

// Task 44 item B. Cosmetic, but the value is shared across three
// components that sit in one visual column (ComposerHeader above the
// composer above the response panel), so the thing worth pinning is that
// they agree -- a later change to one alone would visibly misalign the
// discussion name from the prompt text it labels.

afterEach(cleanup);

const INSET = "12px";

describe("horizontal content inset", () => {
  test("the response panel is inset, not flush to the panel edge", () => {
    const { container } = render(
      <DiscussionContent
        discussionId="d1"
        history={[]}
        streamedResponse={null}
        streamedResponseCreatedAt={null}
        isStreaming={false}
        isRunning={false}
        executionError={null}
      />,
    );
    const main = container.querySelector("main")!;
    expect(main.style.paddingLeft).toBe(INSET);
    expect(main.style.paddingRight).toBe(INSET);
  });

  test("ComposerHeader uses the same inset, so the column lines up", () => {
    render(
      <ComposerHeader
        discussionId="d1"
        discussionName="A discussion"
        isRunning={false}
      />,
    );
    const row = document.querySelector('[role="group"]') as HTMLElement;
    expect(row.style.paddingLeft).toBe(INSET);
    expect(row.style.paddingRight).toBe(INSET);
  });
});
