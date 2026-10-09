"use client";

import { useState } from "react";
import { DialogFrame } from "./DialogFrame";
import { countDocImages } from "@/lib/historyBudget";
import type { ContextChoice } from "@/lib/historyPlan";
import type { RichContent } from "@/lib/richContent";
import { contextSummary } from "./contextSummary";
import { useHistoryPlan } from "./useHistoryPlan";

// Task 71 Stage 2. "What to send with this question": tick the earlier
// turns to send, and untick a turn's pictures to leave them out. Applies
// to the next question only (Workspace resets it after the run), and
// deletes nothing.
//
// Touch friendly for Nik's iPad: every row is at least 44px tall and the
// whole row label is the tap target, not only the small box.

export interface ContextTurn {
  id: string;
  prompt_text: string;
  prompt_content: RichContent | null;
  response: string | null;
}

const ROW = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 44,
  cursor: "pointer",
} as const;
const BOX = { width: 22, height: 22, flex: "0 0 auto" } as const;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
}

export function ContextDialog({
  open,
  turns,
  choice,
  discussionId,
  content,
  onDone,
  onCancel,
}: {
  open: boolean;
  // Completed earlier turns, oldest first.
  turns: ContextTurn[];
  choice: ContextChoice | undefined;
  discussionId: string | null;
  content: RichContent;
  onDone: (choice: ContextChoice | undefined) => void;
  onCancel: () => void;
}) {
  const allIds = turns.map((t) => t.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picturesOff, setPicturesOff] = useState<Set<string>>(new Set());

  // Reset during render each time it opens, from the current choice --
  // the idiom the other dialogs use (RenameDialog).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(new Set(choice?.turnIds ?? allIds));
      setPicturesOff(new Set(choice?.picturesOff ?? []));
    }
  }

  const draft: ContextChoice | undefined =
    selected.size === allIds.length && picturesOff.size === 0
      ? undefined
      : {
          turnIds: allIds.filter((id) => selected.has(id)),
          picturesOff: [...picturesOff].filter((id) => selected.has(id)),
        };
  const plan = useHistoryPlan(discussionId, content, draft, turns.length, open);

  if (!open) return null;

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const newestFirst = turns
    .map((turn, index) => ({ turn, number: index + 1 }))
    .reverse();

  return (
    <DialogFrame label="What to send with this question" onCancel={onCancel}>
      <h2 style={{ marginTop: 0 }}>What to send with this question</h2>
      <p
        data-context-dialog-summary
        style={{ marginTop: 0, color: "#444", minHeight: "2.6em" }}
      >
        {plan ? contextSummary(plan) : "Working it out…"}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          style={{ minHeight: 44 }}
          onClick={() => {
            setSelected(new Set(allIds));
            setPicturesOff(new Set());
          }}
        >
          All turns
        </button>
        <button
          type="button"
          style={{ minHeight: 44 }}
          onClick={() => setSelected(new Set(allIds.slice(-1)))}
        >
          Only the last turn
        </button>
        <button
          type="button"
          style={{ minHeight: 44 }}
          onClick={() => setSelected(new Set())}
        >
          No earlier turns
        </button>
      </div>

      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
        {newestFirst.map(({ turn, number }) => {
          const pictures = countDocImages(turn.prompt_content);
          const on = selected.has(turn.id);
          return (
            <li
              key={turn.id}
              data-context-turn={number}
              style={{ borderTop: "1px solid #ddd", padding: "4px 0" }}
            >
              <label style={ROW}>
                <input
                  type="checkbox"
                  style={BOX}
                  checked={on}
                  onChange={() => setSelected((s) => toggle(s, turn.id))}
                />
                <span>
                  <strong>Turn {number}</strong> · {preview(turn.prompt_text)}
                </span>
              </label>
              {pictures > 0 && (
                <label
                  style={{
                    ...ROW,
                    paddingLeft: 32,
                    color: on ? "inherit" : "#999",
                  }}
                >
                  <input
                    type="checkbox"
                    style={BOX}
                    disabled={!on}
                    checked={on && !picturesOff.has(turn.id)}
                    onChange={() => setPicturesOff((s) => toggle(s, turn.id))}
                  />
                  <span>
                    send its{" "}
                    {pictures === 1 ? "picture" : `${pictures} pictures`}
                  </span>
                </label>
              )}
            </li>
          );
        })}
      </ul>

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={onCancel} style={{ minHeight: 44 }}>
          Cancel
        </button>{" "}
        <button
          type="button"
          onClick={() => onDone(draft)}
          style={{ minHeight: 44 }}
        >
          Done
        </button>
      </div>
    </DialogFrame>
  );
}
