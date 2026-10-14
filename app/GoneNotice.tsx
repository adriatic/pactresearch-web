"use client";

import { useState } from "react";
import { EmptyStateHint } from "./EmptyStateHint";

// Task 84. Shown in the work area, in place of the title line, the prompt
// box and the prompt and response panel, when what it showed was deleted
// in another tab or window (Workspace.tsx decides when).
//
// Unsent prompt text is offered back rather than thrown away: a long
// prompt must never be lost to a deletion made somewhere else. Plain text
// only -- pictures pasted into that prompt are not carried over (the copy
// goes to the clipboard as text). "Show it" is there for when the
// clipboard is refused (some browsers, some permission settings), so the
// text can still be selected by hand.
//
// Task 93. Each picture in that text is a numbered placeholder
// ("[picture 1]", ...), and one sentence says the pictures cannot be
// recovered: they are removed from storage before this tab learns of
// the deletion.
export interface GoneNoticeState {
  message: string;
  unsentText: string | null;
  unsentPictureCount: number;
}

export function picturesNotRecoveredText(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) {
    return "Your picture cannot be recovered; [picture 1] shows where it was.";
  }
  const where =
    count === 2
      ? "[picture 1] and [picture 2]"
      : `[picture 1] to [picture ${count}]`;
  return `Your ${count} pictures cannot be recovered; ${where} show where they were.`;
}

export function GoneNotice({
  notice,
  notebookCount,
}: {
  notice: GoneNoticeState;
  // Task 91. Null while the tree is still loading.
  notebookCount: number | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  const picturesNote = picturesNotRecoveredText(notice.unsentPictureCount);

  async function copy() {
    if (!notice.unsentText) return;
    try {
      await navigator.clipboard.writeText(notice.unsentText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <section
      data-gone-notice
      aria-label="Work area"
      style={{ padding: "16px", overflowY: "auto" }}
    >
      <p style={{ marginTop: 0, fontWeight: "bold" }}>{notice.message}</p>
      <EmptyStateHint notebookCount={notebookCount} />
      {notice.unsentText && (
        <div data-unsent-prompt>
          <p style={{ marginBottom: 4 }}>
            You had a prompt that was not run.{" "}
            <button type="button" onClick={() => void copy()}>
              Copy your unsent prompt
            </button>{" "}
            {copyState === "copied" && <span>Copied.</span>}
            {copyState === "failed" && (
              <span>
                Could not copy. Open “Show it” and copy it from there.
              </span>
            )}
          </p>
          {picturesNote && (
            <p data-unsent-pictures style={{ marginTop: 0, marginBottom: 4 }}>
              {picturesNote}
            </p>
          )}
          <details>
            <summary>Show it</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                userSelect: "text",
              }}
            >
              {notice.unsentText}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
