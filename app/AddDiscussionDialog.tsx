"use client";

import { useRef, useState } from "react";
import { DialogFrame } from "./DialogFrame";

// Task 60. Adding a discussion to an existing notebook, from that
// notebook's own row menu.
//
// This replaces the separate "Add a discussion to this notebook" panel
// as the entry point. The panel's logic is MOVED here rather than
// rewritten -- the duplicate-name pre-check and the in-flight guard
// both exist for reasons that did not go away with the panel:
//
//   - The database has a per-notebook unique constraint on discussion
//     name. Hitting it produces a raw constraint error; checking first
//     produces a sentence a person can act on. Read fresh from the
//     server rather than from anything cached, so a discussion added
//     since this dialog opened still counts.
//
//   - discussionInFlight guards double submission: the button is
//     disabled while saving, but a fast second Enter can still arrive
//     before React re-renders.
//
// Modelled on RenameDialog, deliberately: same shape, same reset idiom,
// same explicit Save. The task asked for no redesign, and two dialogs
// that do the same kind of thing should not look like two different
// apps.

interface ExistingDiscussion {
  notebook_id: string;
  name: string | null;
}

export interface AddDiscussionTarget {
  notebookId: string;
  notebookName: string;
}

export function AddDiscussionDialog({
  target,
  onCancel,
  onCreated,
}: {
  target: AddDiscussionTarget | null;
  onCancel: () => void;
  onCreated: (discussionId: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Reset during render, keyed on the notebook being added to -- the
  // same idiom every other dialog here uses, and for the reason task 51
  // found the hard way: this component renders null rather than
  // unmounting, so `saving` left true by a success would leave it dead
  // on its next open.
  const targetKey = target ? target.notebookId : null;
  const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
  if (targetKey !== lastTargetKey) {
    setLastTargetKey(targetKey);
    setName("");
    setError(null);
    setSaving(false);
    // inFlight is deliberately NOT reset here. Touching a ref during
    // render is forbidden (react-hooks/refs), and it is unnecessary:
    // handleCreate clears it in a finally, so it cannot survive a
    // completed attempt — unlike `saving`, whose reset above guards the
    // never-unmounts case task 51 found.
  }

  if (!target) return null;

  const trimmed = name.trim();

  async function handleCreate() {
    if (!target || !trimmed || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);

    try {
      const existingResponse = await fetch("/api/discussions");
      if (existingResponse.ok) {
        const existing = (await existingResponse.json()) as
          ExistingDiscussion[] | null;
        const normalized = trimmed.toLowerCase();
        const isDuplicate = (existing ?? []).some(
          (discussion) =>
            discussion.notebook_id === target.notebookId &&
            (discussion.name ?? "").trim().toLowerCase() === normalized,
        );
        if (isDuplicate) {
          setError(
            `This notebook already has a discussion named "${trimmed}". Pick a different name.`,
          );
          return;
        }
      }

      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notebookId: target.notebookId,
          name: trimmed,
        }),
      });
      const body = await response.json();
      if (response.ok) {
        onCreated(body.id);
        return;
      }
      setError(body.error || "Failed to create discussion.");
    } catch {
      setError("Failed to create discussion — please try again.");
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  return (
    <DialogFrame label="Add discussion" onCancel={onCancel} busy={saving}>
      <h2 style={{ marginTop: 0 }}>Add discussion</h2>
      <p style={{ marginTop: 0, color: "#666", fontSize: "0.9em" }}>
        It will be added to <strong>{target.notebookName}</strong>, after the
        discussions already there.
      </p>

      <label>
        Name:
        <br />
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // In a dialog, not a form, so Enter has nothing to submit
            // -- wire it to the obvious action.
            if (e.key === "Enter" && trimmed) {
              e.preventDefault();
              void handleCreate();
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
          onClick={() => void handleCreate()}
          disabled={saving || !trimmed}
        >
          {saving ? "Adding..." : "Add discussion"}
        </button>
      </div>
    </DialogFrame>
  );
}
