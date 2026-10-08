"use client";

import { useState } from "react";
import { DialogFrame } from "./DialogFrame";

// Task 68. Confirms deleting a notebook or a discussion, in the same
// in-app dialog as Rename and Add discussion; it replaces the browser's
// window.confirm, which looked like nothing else in pact-web.
//
// Focus starts on Cancel, so Enter on its own cancels: deleting needs a
// deliberate press of the Delete button. Escape cancels too
// (DialogFrame).
//
// Same `target` idiom as RenameDialog: null is closed. The caller's
// onDelete resolves to an error message or null; on an error the dialog
// stays open and says why (e.g. the 409 for a running discussion).

export interface DeleteTarget {
  kind: "notebook" | "discussion";
  id: string;
  name: string;
  // Notebook only: how many discussions go with it (Task 61's count).
  discussionCount?: number;
}

export function deleteMessage(target: DeleteTarget): string {
  if (target.kind === "discussion") {
    return "Its prompts and responses will be deleted with it. This cannot be undone.";
  }
  const count = target.discussionCount ?? 0;
  const blastRadius =
    count === 0
      ? "It has no discussions."
      : `This will also delete its ${count} discussion${count === 1 ? "" : "s"}.`;
  return `${blastRadius} This cannot be undone.`;
}

export function DeleteDialog({
  target,
  onCancel,
  onDelete,
}: {
  target: DeleteTarget | null;
  onCancel: () => void;
  onDelete: (target: DeleteTarget) => Promise<string | null>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset during render keyed on the target, as RenameDialog does.
  const targetKey = target ? `${target.kind}:${target.id}` : null;
  const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
  if (targetKey !== lastTargetKey) {
    setLastTargetKey(targetKey);
    setDeleting(false);
    setError(null);
  }

  if (!target) return null;

  async function handleDelete() {
    if (!target || deleting) return;
    setDeleting(true);
    setError(null);
    const failure = await onDelete(target);
    if (failure) {
      setError(failure);
      setDeleting(false);
    }
    // Success closes via the caller clearing `target`.
  }

  const noun = target.kind;

  return (
    <DialogFrame label={`Delete ${noun}`} onCancel={onCancel} busy={deleting}>
      <h2 style={{ marginTop: 0 }}>Delete {noun}</h2>
      <p style={{ marginTop: 0 }}>
        Delete {noun} <strong>{target.name}</strong>?
      </p>
      <p>{deleteMessage(target)}</p>

      {error && <p style={{ color: "#a00" }}>{error}</p>}

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={onCancel} disabled={deleting} autoFocus>
          Cancel
        </button>{" "}
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : `Delete ${noun}`}
        </button>
      </div>
    </DialogFrame>
  );
}
