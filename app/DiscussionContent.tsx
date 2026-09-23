"use client";

import type { PastResponse } from "./useDiscussionExecution";
import { MarkdownResponse } from "./MarkdownResponse";

// The scrolling middle region of the fixed layout: the active
// discussion's identifier, its history, the live-streaming response, and
// the last run's raw result — everything from the old ExecuteTester
// except the composer, which now lives separately (Composer.tsx) in its
// own fixed position. Purely a rendering split for layout purposes; none
// of this content or its underlying state changed.

export function DiscussionContent({
  discussionId,
  discussionName,
  history,
  streamedResponse,
  streamedModel,
  streamedResponseCreatedAt,
  isStreaming,
  executionError,
  onRetry,
  retryDisabled,
}: {
  discussionId: string | null;
  discussionName: string | null;
  history: PastResponse[];
  streamedResponse: string | null;
  streamedModel: string | null;
  streamedResponseCreatedAt: string | null;
  isStreaming: boolean;
  executionError: string | null;
  // Task 37 (Retry, ported from pact-mac's task 32 audit): re-runs a past
  // entry's own original prompt content verbatim, as a new response
  // appended to this same discussion — see useDiscussionExecution.ts's
  // retry() for why it never touches the composer's own current draft.
  // pact-web's first per-response control — matches Explorer.tsx's own
  // plain <button> convention (Delete notebook/discussion), since no
  // other per-response control exists yet to match instead.
  onRetry: (entry: PastResponse) => void;
  // Mirrors whatever disables the header's own Run button (execution.loading)
  // — pact-mac's own Retry has no equivalent UI-level guard at all (only a
  // backend-side rejection, whose error event never surfaces anywhere
  // useful in its UI); pact-web's Retry is disabled here instead, the
  // same way Run already is.
  retryDisabled: boolean;
}) {
  return (
    <main>
      {discussionId ? (
        <p>Discussion: {discussionName ?? "Loading..."}</p>
      ) : (
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
                {` — ${new Date(entry.created_at).toLocaleString()}`}:{" "}
                <button
                  type="button"
                  onClick={() => onRetry(entry)}
                  disabled={retryDisabled}
                  title="Run this exact prompt again as a new response"
                >
                  Retry
                </button>
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
