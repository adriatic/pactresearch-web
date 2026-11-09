"use client";

import { OPEN_KEYS_LABEL } from "@/lib/rejectedKeyWords";

// Task D17k. A Run refused because the service rejected the saved key.
//
// Drawn directly above the composer, outside the scrolling list of
// answers, so it is in view however long the discussion is and whatever
// has been scrolled: together with the Run button, the composer and any
// answer's Continue and Ask about this answer only buttons. The words are
// D17i's (lib/rejectedKeyWords.ts), unchanged.
//
// Two ways out: open Account on its Keys tab (the composer and the
// discussion stay as they are), or dismiss it. Saving a key for the same
// service and closing Account clears it too (Workspace).
export function RunKeyError({
  message,
  onOpenKeys,
  onDismiss,
}: {
  message: string;
  onOpenKeys: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Run error"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        border: "1px solid var(--danger)",
        background: "var(--danger-bg)",
        color: "var(--danger)",
        padding: "6px 8px 6px 12px",
        margin: "4px 12px",
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <p
        role="alert"
        style={{ margin: 0, flex: "1 1 260px", minWidth: 0, lineHeight: 1.4 }}
      >
        {message}
      </p>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={onOpenKeys} style={{ minHeight: 32 }}>
          {OPEN_KEYS_LABEL}
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          style={{ minHeight: 32, minWidth: 32 }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
