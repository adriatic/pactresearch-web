"use client";

import { useState } from "react";
import { DialogFrame } from "./DialogFrame";

// Task 54. Renames a notebook or a discussion from the row menu.
//
// A modal rather than an in-place edit inside the tree row. Inline
// editing is the file-explorer convention, but these rows are
// @headless-tree items with their own click, focus and hotkey handling
// (hotkeysCoreFeature is enabled), and putting a focused text input
// inside one means fighting the tree for every keystroke -- typing "e"
// into a rename box should not also trigger whatever the tree binds "e"
// to. A modal has no such conflict, and it matches every other dialog
// in this app.
//
// The `target` prop is a value, not separate open/id/name props, so
// "which row is being renamed" and "is the dialog open" cannot
// disagree: null is closed, non-null is open for exactly that row.

export interface RenameTarget {
  kind: "notebook" | "discussion";
  id: string;
  name: string;
}

export function RenameDialog({
  target,
  onCancel,
  onRename,
}: {
  target: RenameTarget | null;
  onCancel: () => void;
  // Resolves to an error message, or null when the rename succeeded.
  // Kept here rather than in the caller so the dialog stays open and
  // keeps the typed value when the server rejects it.
  onRename: (target: RenameTarget, newName: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset during render, keyed on the row being renamed -- the same
  // idiom AccountDialog, SettingsDialog, ModelTierDialog and
  // NewNotebookDialog all use, and for the reason task 51 found the
  // hard way: this component never unmounts, so `saving` left true by
  // a successful rename would leave every control disabled the next
  // time it opens. Keyed on the id (not just open/closed) so opening
  // it on a different row also refills the field.
  const targetKey = target ? `${target.kind}:${target.id}` : null;
  const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
  if (targetKey !== lastTargetKey) {
    setLastTargetKey(targetKey);
    setName(target?.name ?? "");
    setError(null);
    setSaving(false);
  }

  if (!target) return null;

  const trimmed = name.trim();
  const unchanged = trimmed === target.name.trim();

  async function handleSave() {
    if (!target || !trimmed || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onRename(target, trimmed);
    if (failure) {
      setError(failure);
      setSaving(false);
      return;
    }
    // Success closes via the caller clearing `target`, which also
    // re-runs the reset above.
  }

  const noun = target.kind === "notebook" ? "notebook" : "discussion";

  return (
    <DialogFrame label={`Rename ${noun}`} onCancel={onCancel} busy={saving}>
      <h2 style={{ marginTop: 0 }}>Rename {noun}</h2>

      <label>
        Name:
        <br />
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // This input sits in a dialog, not a form, so Enter has
            // nothing to submit -- wire it to the obvious action.
            if (e.key === "Enter" && trimmed && !unchanged) {
              e.preventDefault();
              void handleSave();
            }
          }}
          disabled={saving}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      {error && <p style={{ color: "#a00" }}>{error}</p>}

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>{" "}
        <button
          type="button"
          onClick={() => void handleSave()}
          // Unchanged is disabled as well as empty: a "Save" that
          // fires a PATCH writing the name it already has is just a
          // way to fail for no reason.
          disabled={saving || !trimmed || unchanged}
        >
          {saving ? "Renaming..." : "Rename"}
        </button>
      </div>
    </DialogFrame>
  );
}
