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

export function DiscussionContent({
  discussionId,
  history,
  streamedResponse,
  streamedModel,
  streamedResponseCreatedAt,
  isStreaming,
  executionError,
}: {
  discussionId: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedModel: string | null;
  streamedResponseCreatedAt: string | null;
  isStreaming: boolean;
  executionError: string | null;
}) {
  return (
    <main>
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
                {entry.resolved_model ? ` — ${entry.resolved_model}` : ""}
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
      {streamedResponse !== null && (
        <div>
          <h2>
            {isStreaming ? "Live response (streaming...)" : "Response"}
            {streamedModel ? ` — ${streamedModel}` : ""}
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
