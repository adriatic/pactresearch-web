"use client";

import { useEffect, useState } from "react";

// The header's "Settings" button opens this — a per-notebook system
// prompt editor. Plain text only, no rich text/Tiptap (this is a system
// prompt sent to Anthropic's own `system` parameter, not composer
// content) and no IPR (pact-mac's AI-assisted multi-turn drafting chat
// for this same field, src/app/setup.tsx) — that's a separate, larger
// feature, out of scope for this task.
//
// Modeled on pact-mac's own Settings dialog minus IPR: a plain textarea,
// an explicit Save (no autosave/debounce — a system prompt changes rarely
// enough that the composer's race-guarded autosave machinery would be
// pure overhead here, and pact-mac itself only ever saves this field on
// an explicit click too), Cancel discards in-memory edits without
// persisting them. A real HTML `placeholder` attribute is used for the
// empty-state hint text (matching pact-mac's own convention) rather than
// prefilled dummy content — a placeholder can never be mistaken for a
// real saved value or accidentally submitted.
//
// Unlike pact-mac (a VSCode webview has no existing modal convention to
// match either), this is pact-web's first real dialog component — no
// existing modal/overlay pattern exists anywhere else in this app to
// reuse (confirmed by searching the whole app directory before writing
// this; the only other "are you sure" UI in the codebase is a native
// window.confirm(), in Explorer.tsx). This establishes the simplest
// thing that reads as a dialog — a fixed backdrop plus a centered plain
// box — kept deliberately unstyled beyond that, consistent with the rest
// of the app's plain-HTML aesthetic (no CSS framework, no design system).
export function SettingsDialog({
  notebookId,
  open,
  onClose,
}: {
  // Which notebook this edits -- Workspace passes the active discussion's
  // own notebookId (see useDiscussionExecution.ts), not Explorer's
  // separately-tracked selectedNotebookId (that one only updates on an
  // explicit tree click and can be stale/null on first load).
  notebookId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which open+notebookId combination `loading`/`systemPrompt` above
  // currently belong to -- reset synchronously, during render (not in the
  // effect below, which only runs after the first paint), the instant the
  // dialog opens for a given notebook. Without this, the very first
  // render after opening still shows loading's *previous* value (false,
  // after any earlier open/close cycle) until the effect's async fetch
  // gets around to setting it true -- a real, confirmed race: a fast
  // enough interaction in that window (an automated test, or just a fast
  // typist) types into the still-enabled textarea, then the fetch
  // resolves a moment later and silently overwrites it with the
  // just-fetched value, discarding what was just typed. Same "adjusted
  // directly during render" idiom useDiscussionExecution.ts's own
  // displayedDiscussionId reset already uses for the identical reason.
  const openKey = open ? notebookId : null;
  const [loadedForKey, setLoadedForKey] = useState<string | null>(null);
  if (openKey !== loadedForKey) {
    setLoadedForKey(openKey);
    if (openKey !== null) {
      setLoading(true);
      setSystemPrompt("");
      setError(null);
    }
  }

  // Fetches the current, real value fresh every time the dialog opens for
  // a given notebook -- never trusts anything cached client-side, so a
  // change made in another tab/session since this last opened is never
  // silently overwritten by a stale value on Save. This is also what
  // makes Cancel "discard unsaved edits" correct with no extra bookkeeping:
  // closing and reopening re-runs this fetch, so an edited-but-never-saved
  // value is simply never seen again once the dialog is reopened.
  useEffect(() => {
    if (!open || !notebookId) return;
    let cancelled = false;

    async function loadSystemPrompt() {
      try {
        const response = await fetch(`/api/notebooks?id=${notebookId}`);
        const body = (await response.json()) as {
          system_prompt: string | null;
        }[];
        if (cancelled) return;
        setSystemPrompt(body[0]?.system_prompt ?? "");
      } catch {
        if (!cancelled) {
          setError("Failed to load the current system prompt.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSystemPrompt();

    return () => {
      cancelled = true;
    };
  }, [open, notebookId]);

  if (!open || !notebookId) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/notebooks?id=${notebookId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt }),
      });
      const body = await response.json();
      if (response.ok) {
        onClose();
      } else {
        setError(body.error || "Failed to save system prompt.");
      }
    } catch {
      setError("Failed to save system prompt — please try again.");
    } finally {
      setSaving(false);
    }
  }

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
        style={{
          background: "#fff",
          border: "1px solid #999",
          padding: 16,
          width: 480,
          maxWidth: "90vw",
          boxSizing: "border-box",
        }}
      >
        <h2>Settings</h2>
        <label>
          System prompt:
          <br />
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Describe the research domain, role, and analytical stance the model should take..."
            rows={8}
            disabled={loading || saving}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>
        {error && <p style={{ color: "#a00" }}>{error}</p>}
        <div>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>{" "}
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
