"use client";

import { useEffect, useRef, useState } from "react";
import { plainTextToDoc } from "@/lib/richContent";
import {
  REFINE_MISSING_KEY_CODE,
  REFINE_MISSING_KEY_MESSAGE,
} from "@/lib/refineDraft";

// Task 52. "New Notebook" as a modal, replacing the flat inline form.
//
// CATEGORIES stays at two. The task listed "Personal Research / Samples /
// Dev Test" and said "unchanged" -- but Samples does not exist in
// pact-web: it was cut deliberately (decision 3.13), and
// app/api/notebooks/route.ts rejects it with a 400, noting in its own
// comment that the old pact-mac dialog offered it. The parenthetical is
// a transcription of that dialog; "unchanged" is the instruction. Adding
// Samples would mean either shipping an option that 400s or quietly
// reversing 3.13, so it is flagged in the report instead.
const CATEGORIES = ["Personal Research", "Dev Test"] as const;
type Category = (typeof CATEGORIES)[number];

// A list, not a hardcoded value, specifically so a second mode drops in
// without rearchitecting -- the task asked for the structure even though
// only one option exists today. `enabled` is what a future mode flips.
const EXECUTION_MODES = [
  {
    value: "interactive",
    label: "Interactive",
    hint: "Run prompts yourself, one at a time.",
    enabled: true,
  },
] as const;
type ExecutionMode = (typeof EXECUTION_MODES)[number]["value"];

// The auto-created first discussion is named after its notebook --
// "Alpha" gets "Alpha-d-1" -- rather than after a truncated copy of the
// research question, which made long questions produce unreadable
// elided row labels and duplicated text the composer already shows.
//
// Only the auto-created one. A discussion the user adds themselves is
// still named by the user, and this is not a running counter: nothing
// else creates a "-d-N", so there is no -d-2 today. The name is meant
// to be a placeholder the user can change, which is what task 54's
// Rename action in the row menu is for.
export function firstDiscussionName(notebookName: string): string {
  return `${notebookName.trim()}-d-1`;
}

export function NewNotebookDialog({
  open,
  onClose,
  onNotebookCreated,
  onDiscussionCreated,
}: {
  open: boolean;
  onClose: () => void;
  onNotebookCreated: (notebookId: string) => void;
  onDiscussionCreated: (discussionId: string) => void;
}) {
  const [name, setName] = useState("");
  const [executionMode, setExecutionMode] =
    useState<ExecutionMode>("interactive");
  const [category, setCategory] = useState<Category>(CATEGORIES[0]);
  const [researchQuestion, setResearchQuestion] = useState("");
  // Task 53. Excluded from task 52 on purpose: putting an editable
  // System Prompt here before knowing it was honoured at execution time
  // would have been a field that looks like it does something and does
  // not. Step 1 established it IS honoured -- /api/execute reads
  // notebooks.system_prompt and sends it to Anthropic as `system` --
  // so it is real, and now it is here.
  const [systemPrompt, setSystemPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Task 98. Refine with AI, one-shot, the same route and instruction as
  // Settings. `lastDraft` is the draft last put in the System prompt
  // field: a new draft may replace the field without asking only while
  // the field is empty or still holds exactly that. `pendingDraft` is a
  // draft waiting on the Replace / Keep question.
  const [refineDescription, setRefineDescription] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [lastDraft, setLastDraft] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  // Counts opens and closes. A Refine answer is used only if this has not
  // moved since it was asked, so an answer that arrives after the dialog
  // closed is dropped instead of landing in a later New Notebook dialog
  // (this component stays mounted while closed).
  const openingRef = useRef(0);
  useEffect(() => {
    openingRef.current += 1;
  }, [open]);
  // The field as it is when the answer arrives, not as it was when Send
  // was pressed: the user may type in it while waiting.
  const fieldRef = useRef({ systemPrompt, lastDraft });
  useEffect(() => {
    fieldRef.current = { systemPrompt, lastDraft };
  }, [systemPrompt, lastDraft]);

  // Cleared on each open so a cancelled draft never reappears -- and,
  // critically, so does `creating`.
  //
  // The success path below calls onClose() without unsetting `creating`,
  // and closing only makes this component render null; it stays mounted.
  // Without resetting it here, the next open has every field and button
  // disabled forever. That is exactly the bug task 51 fixed in
  // ModelTierDialog, and the E2E caught it here before it shipped: the
  // Name input resolved to <input disabled> on the second create.
  const openKey = open ? "open" : null;
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    if (openKey !== null) {
      setName("");
      setExecutionMode("interactive");
      setCategory(CATEGORIES[0]);
      setResearchQuestion("");
      setSystemPrompt("");
      setError(null);
      setCreating(false);
      setRefineDescription("");
      setRefining(false);
      setRefineError(null);
      setLastDraft(null);
      setPendingDraft(null);
    }
  }

  if (!open) return null;

  async function handleRefine() {
    const description = refineDescription.trim();
    if (!description || refining) return;
    const opening = openingRef.current;
    setRefining(true);
    setRefineError(null);
    setPendingDraft(null);

    let result: { systemPrompt: string } | { error: string };
    try {
      const response = await fetch("/api/refine-system-prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const body = (await response.json()) as {
        systemPrompt?: string;
        error?: string;
        code?: string;
      };
      if (response.ok && body.systemPrompt) {
        result = { systemPrompt: body.systemPrompt };
      } else if (body.code === REFINE_MISSING_KEY_CODE) {
        result = { error: REFINE_MISSING_KEY_MESSAGE };
      } else {
        result = { error: body.error || "Couldn't draft a system prompt." };
      }
    } catch {
      result = { error: "Couldn't draft a system prompt — please try again." };
    }

    // Closed (and maybe reopened) while waiting: this answer belongs to a
    // dialog that is gone.
    if (openingRef.current !== opening) return;
    setRefining(false);
    if ("error" in result) {
      setRefineError(result.error);
      return;
    }
    const draft = result.systemPrompt;
    const field = fieldRef.current;
    if (!field.systemPrompt.trim() || field.systemPrompt === field.lastDraft) {
      setSystemPrompt(draft);
      setLastDraft(draft);
    } else {
      setPendingDraft(draft);
    }
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName || creating) return;
    setCreating(true);
    setError(null);

    try {
      const notebookResponse = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Trimmed to null rather than sent as whitespace: PATCH
        // /api/notebooks already normalises "blank means none" at the
        // one place it writes, and a notebook created with "   " should
        // land in the same state as one created with nothing.
        body: JSON.stringify({
          name: trimmedName,
          category,
          systemPrompt: systemPrompt.trim() || null,
        }),
      });
      const notebookBody = await notebookResponse.json();
      if (!notebookResponse.ok) {
        setError(notebookBody.error || "Failed to create notebook.");
        setCreating(false);
        return;
      }
      onNotebookCreated(notebookBody.id);

      const question = researchQuestion.trim();
      if (!question) {
        // No question: just the notebook, same as the old flat form.
        // "Add a discussion to this notebook" remains available for the
        // next step.
        onClose();
        return;
      }

      // A research question only means something if there is a composer
      // to put it in, so it also creates the notebook's first
      // discussion and seeds that discussion's draft with it. The draft
      // is how it reaches the composer: the switch-load reads
      // draft_content, so selecting the new discussion shows the
      // question ready to run or edit. No new column, and no special
      // in-memory path that a reload would lose.
      const discussionResponse = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notebookId: notebookBody.id,
          name: firstDiscussionName(trimmedName),
        }),
      });
      const discussionBody = await discussionResponse.json();
      if (!discussionResponse.ok) {
        // The notebook exists at this point, so this is a partial
        // success rather than a failure -- say so instead of implying
        // nothing happened.
        setError(
          discussionBody.error ||
            "Notebook created, but its first discussion could not be added.",
        );
        setCreating(false);
        return;
      }

      await fetch(`/api/discussions?id=${discussionBody.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftContent: plainTextToDoc(question) }),
      }).catch(() => {
        // Best effort. The discussion exists either way; losing the
        // pre-filled question is a smaller failure than blocking on it.
      });

      onDiscussionCreated(discussionBody.id);
      onClose();
    } catch {
      setError("Failed to create notebook — please try again.");
      setCreating(false);
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
        role="dialog"
        aria-label="New notebook"
        style={{
          background: "#fff",
          border: "1px solid #999",
          padding: 16,
          width: 520,
          maxWidth: "90vw",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ marginTop: 0 }}>New notebook</h2>

        <label>
          Name:
          <br />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>
        <br />

        <fieldset
          disabled={creating}
          style={{ border: "1px solid #ccc", margin: "8px 0", padding: 8 }}
        >
          <legend>Execution mode</legend>
          {EXECUTION_MODES.map((mode) => (
            <label key={mode.value} style={{ display: "block" }}>
              <input
                type="radio"
                name="execution-mode"
                value={mode.value}
                checked={executionMode === mode.value}
                disabled={!mode.enabled}
                onChange={() => setExecutionMode(mode.value)}
              />{" "}
              {mode.label}{" "}
              <span style={{ color: "#666", fontSize: "0.9em" }}>
                — {mode.hint}
              </span>
            </label>
          ))}
        </fieldset>

        <label>
          Category:
          <br />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            disabled={creating}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <br />

        <label>
          Research question:
          <br />
          <textarea
            value={researchQuestion}
            onChange={(e) => setResearchQuestion(e.target.value)}
            rows={3}
            disabled={creating}
            placeholder="Optional — this becomes the notebook's first discussion, ready in the composer."
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>

        {/* Task 98. Above the System prompt field, as decided: one short
            line and a send arrow. One-shot, like Settings: the draft goes
            into the field below, and nothing about Refine is stored. */}
        <div style={{ marginTop: 8 }}>
          <label>
            Refine with AI:
            <br />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="Describe your research domain..."
                value={refineDescription}
                onChange={(e) => setRefineDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // A dialog, not a form: Enter has nothing else to do.
                    e.preventDefault();
                    void handleRefine();
                  }
                }}
                disabled={creating || refining}
                style={{ flex: 1, boxSizing: "border-box" }}
              />
              <button
                type="button"
                aria-label="Send"
                title="Send"
                onClick={() => void handleRefine()}
                disabled={creating || refining || !refineDescription.trim()}
              >
                →
              </button>
            </div>
          </label>
          {refining && (
            <p style={{ margin: "4px 0 0", color: "#666", fontSize: "0.85em" }}>
              Drafting a system prompt…
            </p>
          )}
          {refineError && (
            <p style={{ margin: "4px 0 0", color: "#a00", fontSize: "0.85em" }}>
              {refineError}
            </p>
          )}
          {pendingDraft !== null && (
            <div style={{ margin: "4px 0 0", fontSize: "0.85em" }}>
              A draft is ready, but you have written your own text in the System
              prompt field. Replace it with the draft?{" "}
              <button
                type="button"
                onClick={() => {
                  setSystemPrompt(pendingDraft);
                  setLastDraft(pendingDraft);
                  setPendingDraft(null);
                }}
              >
                Replace my text
              </button>{" "}
              <button type="button" onClick={() => setPendingDraft(null)}>
                Keep my text
              </button>
            </div>
          )}
        </div>

        <label>
          System prompt:
          <br />
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            disabled={creating}
            placeholder={
              "Instructions Claude follows for every prompt in this notebook — " +
              "e.g. 'You are reviewing legal contracts for ambiguous liability " +
              "clauses. Flag anything unusual and cite the specific clause.' " +
              "Leave blank for no special instructions."
            }
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </label>
        {/* The two states this app actually has, named plainly.
            
            Deliberately NOT worded as overriding a default. pact-web has
            no global or default system prompt -- app_settings holds only
            max_tokens -- so a notebook with none set sends no `system`
            parameter to Anthropic at all. Saying "using the default"
            would invent a layer that does not exist, which is the same
            dishonest-UI problem that kept this field out of task 52.

            Deliberately NOT role="status", for two reasons. This text
            changes on every keystroke, so a live region would announce
            it continuously while someone types -- noise, not help. And
            report-a-problem.spec.ts asserts on an unqualified
            page.getByRole("status"); DiscussionContent.tsx already
            carries a comment about avoiding exactly this collision,
            and a second status node would be a strict-mode violation
            waiting for the first spec that opens this modal. */}
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: "0.85em" }}>
          {systemPrompt.trim()
            ? "System prompt set — it will apply to every prompt run in this notebook."
            : "No system prompt — runs in this notebook use none. You can add one later in Settings."}
        </p>
        <br />

        {error && <p style={{ color: "#a00" }}>{error}</p>}

        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={onClose} disabled={creating}>
            Cancel
          </button>{" "}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
          >
            {creating ? "Creating..." : "Create notebook"}
          </button>
        </div>
      </section>
    </div>
  );
}
