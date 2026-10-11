"use client";

import { useState } from "react";

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
export interface GoneNoticeState {
  message: string;
  unsentText: string | null;
}

export function GoneNotice({ notice }: { notice: GoneNoticeState }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

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
      <p>Pick a discussion in the tree, or press New Notebook.</p>
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
