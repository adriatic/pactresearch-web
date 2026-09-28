"use client";

import { useState } from "react";
import { plainTextToDoc } from "@/lib/richContent";

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
    }
  }

  if (!open) return null;

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

        {/* Refine with AI: present but inactive, and deliberately styled
            so that reads as "not available yet" rather than "broken".
            An unstyled disabled button looks identical to one that is
            simply failing to respond. No backend wiring -- that is task
            53's territory. */}
        <div
          // Deliberately NOT aria-hidden. A disabled control is a state
          // assistive tech already conveys ("dimmed"/"unavailable"), and
          // hiding the block outright would also hide the "Coming soon."
          // line that explains WHY it does nothing -- which is the part
          // that stops it reading as broken.
          style={{ opacity: 0.5, cursor: "not-allowed", marginTop: 8 }}
          title="Not available yet"
        >
          <label>
            Refine with AI:
            <br />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="Describe your research domain..."
                disabled
                style={{
                  flex: 1,
                  boxSizing: "border-box",
                  background: "#f2f2f2",
                }}
              />
              <button type="button" disabled>
                Send
              </button>
            </div>
          </label>
          <p style={{ margin: "4px 0 0", color: "#666", fontSize: "0.85em" }}>
            Coming soon.
          </p>
        </div>

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
