"use client";

import type { PastResponse } from "./useDiscussionExecution";
import { MarkdownResponse } from "./MarkdownResponse";

// The scrolling middle region of the fixed layout: the active
// discussion's history, the live-streaming response, and the last run's
// raw result — everything from the old ExecuteTester except the composer,
// which now lives separately (Composer.tsx) in its own fixed position.
// Purely a rendering split for layout purposes; none of this content or
// its underlying state changed.
//
// The active discussion's NAME is deliberately not rendered here (task
// 38). It used to lead this region as "Discussion: <name>", but task 37
// added ComposerHeader directly above the composer, which shows the same
// name — so it appeared twice on screen. ComposerHeader is now the single
// source of truth for it, and is the better home: it's fixed, whereas
// this region scrolls, so the name here would scroll out of view anyway.
// Persistence audit finding E's own reasoning (never show a raw uuid as
// identifying text, even transiently) moved with it — see ComposerHeader.
//
// The "no discussion selected" line below is kept, despite ComposerHeader
// also covering that state, because this one carries the extra guidance
// ("create or pick one above") that belongs in the empty content area
// rather than in a one-line status row.

// Task 42 Part C. Colocated in this component's own JS chunk rather than
// app/globals.css, for the reason Composer.tsx records at length: a
// preview build on the task 37 branch once shipped correct JS alongside a
// STALE compiled globals.css, silently dropping that component's only
// visible rule. This indicator has the same property -- the animation IS
// the feature, so a dropped stylesheet would leave a static glyph and no
// signal that anything is happening. Keeping it here keeps it off the
// build-cache path entirely.
//
// prefers-reduced-motion is honoured: the star stops rotating and the
// whole thing degrades to a static glyph plus its label, which still
// answers "is it alive?" without animating anything.
const THINKING_STYLE = `
@keyframes pw-thinking-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes pw-thinking-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
.pw-thinking {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #888;
  font-size: 0.9rem;
  padding: 0.75rem 0;
}
.pw-thinking-star {
  display: inline-block;
  font-size: 1rem;
  line-height: 1;
  animation:
    pw-thinking-spin 1.6s linear infinite,
    pw-thinking-pulse 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .pw-thinking-star { animation: none; }
}
`;

// Purely an "the app is alive" signal -- deliberately no percentage, no
// ETA, nothing implying knowledge of how much longer the run will take,
// because nothing here has that knowledge.
function ThinkingIndicator() {
  return (
    // aria-hidden, and deliberately NOT role="status".
    //
    // This is a visual affordance, not new information: ComposerHeader
    // (task 37) already exposes run state as a live region announcing
    // "Running, Ns elapsed", which is strictly more informative than
    // "Thinking...". A second polite live region saying the same thing
    // would make a screen reader announce the run twice, and the elapsed
    // timer means the header's version is the one worth hearing. What
    // this element adds is purely positional -- the signal in the place a
    // sighted user is actually looking (the empty response panel), which
    // the header cannot do.
    //
    // It also has to not be role="status" for a concrete reason: task
    // 39's report-a-problem spec asserts on page.getByRole("status") to
    // confirm it is mid-run, and a second status node makes that a
    // strict-mode violation. Discovered by that spec failing, which is
    // the check working as intended.
    <div className="pw-thinking" aria-hidden="true">
      <style>{THINKING_STYLE}</style>
      <span className="pw-thinking-star">✦</span>
      Thinking…
    </div>
  );
}

// Task 43 item 3 removed the model name from both response header lines
// -- the live one ("Response — <model> — <date>") and each history
// entry's equivalent. Only the DISPLAY is gone: useDiscussionExecution
// still tracks streamedModel, /api/execute still resolves and persists
// responses.resolved_model, .pact export/import still carries it, and
// /admin/timings still shows it. Nothing downstream reads it from here,
// so this is a display-layer change only.

export function DiscussionContent({
  discussionId,
  history,
  streamedResponse,
  streamedResponseCreatedAt,
  isStreaming,
  isRunning,
  executionError,
}: {
  discussionId: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedResponseCreatedAt: string | null;
  isStreaming: boolean;
  isRunning: boolean;
  executionError: string | null;
}) {
  return (
    // Task 44 item B: same 12px horizontal inset as the composer and
    // ComposerHeader, so the prompt a user types and the response they
    // read line up in one column rather than each starting at a
    // different edge.
    <main style={{ paddingLeft: 12, paddingRight: 12 }}>
      {!discussionId && (
        <p>No discussion selected — create or pick one above.</p>
      )}
      {discussionId && history.length > 0 && (
        <div>
          {history.map((entry) => (
            <div key={entry.id}>
              <p>
                <strong>Prompt:</strong> {entry.prompt_text}
              </p>
              <p>
                <strong>Response</strong>
                {/* Each entry's own created_at, not a single header-level
                    value -- 7986c92 originally put this on the
                    "Discussion:" line sourced from the *latest* response,
                    which stayed wrong for every older entry once you
                    scrolled past it. */}
                {` — ${new Date(entry.created_at).toLocaleString()}`}:
              </p>
              <MarkdownResponse content={entry.response ?? ""} />
            </div>
          ))}
        </div>
      )}
      {/* Sits exactly where the response is about to land -- below any
          history, above the streamed response -- rather than relying on
          ComposerHeader's status dot (tasks 37/38), which is correct but
          easy to miss and nowhere near where the user is looking.
          `isRunning` is useDiscussionExecution's existing `loading`, the
          same value already driving the Run button and that status dot,
          so all three can never disagree. The streamedResponse === null
          half is what makes this "still working" rather than "still
          running": the moment the first throttled write arrives this
          disappears and the real content takes its place, whatever the
          write throttle interval happens to be (Part B changes nothing
          here). */}
      {isRunning && streamedResponse === null && <ThinkingIndicator />}
      {streamedResponse !== null && (
        <div>
          <h2>
            {isStreaming ? "Live response (streaming...)" : "Response"}
            {streamedResponseCreatedAt &&
              ` — ${new Date(streamedResponseCreatedAt).toLocaleString()}`}
          </h2>
          <MarkdownResponse content={streamedResponse} />
        </div>
      )}
      {executionError && <p>{executionError}</p>}
    </main>
  );
}
