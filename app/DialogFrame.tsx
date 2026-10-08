"use client";

import { useEffect, type ReactNode } from "react";

// Task 68. The overlay and box that RenameDialog and AddDiscussionDialog
// each spelled out by hand (identical styles, 420px wide), now in one
// place so the delete confirmation is the same dialog rather than a look-
// alike. Height and scrolling come from the global section[role="dialog"]
// rule in globals.css (Task 75).
//
// Escape cancels, as in RowMenu -- none of these dialogs had it before.
// Ignored while `busy`, the same rule as their disabled Cancel buttons:
// closing mid-request would hide its result.
export function DialogFrame({
  label,
  onCancel,
  busy = false,
  children,
}: {
  label: string;
  onCancel: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{
          background: "#fff",
          border: "1px solid #999",
          padding: 16,
          width: 420,
          maxWidth: "90vw",
          boxSizing: "border-box",
        }}
      >
        {children}
      </section>
    </div>
  );
}
