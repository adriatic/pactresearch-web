"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

interface PastResponse {
  id: string;
  prompt_text: string;
  response: string | null;
  resolved_model: string | null;
}

interface DiscussionRow {
  id: string;
  draft_prompt_text: string | null;
}

export function ExecuteTester({
  discussionId,
}: {
  discussionId: string | null;
}) {
  const [promptText, setPromptText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState<string | null>(null);
  const [streamedModel, setStreamedModel] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [history, setHistory] = useState<PastResponse[]>([]);

  // Non-persisted live-run display state — cleared immediately, during
  // render, the moment discussionId changes, so a previous discussion's
  // response never flashes next to a different (or absent) active
  // discussion. Adjusted directly during render, same pattern as
  // NotebookCreator's deleted-notebook clear: an effect calling setState
  // synchronously in its body here would trigger an avoidable extra
  // render pass (react-hooks/set-state-in-effect). promptText and history
  // used to be reset here too (see 4d64d02) — they're real persisted data
  // now (see the effect below), not in-memory state that needs resetting.
  const [displayedDiscussionId, setDisplayedDiscussionId] =
    useState(discussionId);
  if (discussionId !== displayedDiscussionId) {
    setDisplayedDiscussionId(discussionId);
    setResult(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setIsStreaming(false);
  }

  // Always holds the latest promptText, readable from the effect below
  // without a stale closure — promptText changes on every keystroke, but
  // that effect only re-runs when discussionId itself changes.
  const promptTextRef = useRef(promptText);
  useEffect(() => {
    promptTextRef.current = promptText;
  }, [promptText]);

  // Which discussion is currently "claimed" as active by this effect —
  // the outgoing discussion to save the draft against on the next switch.
  // Claimed synchronously at the very start of each effect invocation
  // (inside the effect, before any await — not during render, so this
  // isn't subject to the render-time ref-write restriction), not only
  // after a load fully completes. That distinction matters: if it were
  // only updated on load completion, a second switch that starts before
  // the first one's load has finished would still see the *original*
  // discussion as outgoing, never learning the first switch ever
  // happened — exactly the bug this fixes. null on first mount.
  const activeDiscussionIdRef = useRef<string | null>(null);

  // Single source of truth for both history and the persisted draft:
  // switching discussions saves the outgoing discussion's draft first —
  // awaited, so switching back can't observe a lost save racing against
  // the incoming discussion's load — then loads the new discussion's
  // history and persisted draft. Nothing here is a special-cased
  // in-memory value; it's real data, fetched and saved through the
  // database like everything else in this component.
  useEffect(() => {
    let cancelled = false;

    async function saveThenLoad() {
      const outgoingDiscussionId = activeDiscussionIdRef.current;
      const outgoingDraft = promptTextRef.current;
      activeDiscussionIdRef.current = discussionId;

      // outgoingDiscussionId === discussionId means this invocation isn't
      // a genuine switch — either the very first claim for this target,
      // or React Strict Mode's dev-only second invocation of the same
      // target (the first invocation already claimed it). Only a real
      // mismatch is a genuine outgoing discussion to save.
      if (outgoingDiscussionId && outgoingDiscussionId !== discussionId) {
        await fetch(`/api/discussions?id=${outgoingDiscussionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draftPromptText: outgoingDraft || null }),
        });
      }

      if (cancelled) return;

      if (!discussionId) {
        setPromptText("");
        setHistory([]);
        return;
      }

      const [historyBody, discussionsBody] = await Promise.all([
        fetch(`/api/responses?discussionId=${discussionId}`).then((r) =>
          r.json(),
        ),
        fetch(`/api/discussions?id=${discussionId}`).then((r) => r.json()),
      ]);

      if (cancelled) return;

      setHistory(historyBody);
      const loadedDiscussion = (discussionsBody as DiscussionRow[])[0];
      setPromptText(loadedDiscussion?.draft_prompt_text ?? "");
    }

    saveThenLoad();

    return () => {
      cancelled = true;
    };
  }, [discussionId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!discussionId) return;
    setLoading(true);
    setResult(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setIsStreaming(false);

    const supabase = createClient();
    // Which responses row this run is watching — captured from the first
    // INSERT event, so later UPDATE events for some *other* response on
    // this discussion (a future run) don't get applied to this display.
    let watchedRowId: string | null = null;

    const channel = supabase
      .channel(`responses-${discussionId}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (watchedRowId) return;
          watchedRowId = payload.new.id;
          setStreamedModel(payload.new.resolved_model ?? null);
          setStreamedResponse(payload.new.response ?? "");
          setIsStreaming(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (!watchedRowId || payload.new.id !== watchedRowId) return;
          setStreamedResponse(payload.new.response ?? "");
        },
      );

    try {
      // Wait for the subscription to actually be established before
      // firing the POST — otherwise the earliest INSERT (message_start)
      // could land before anything is listening for it.
      await new Promise<void>((resolve, reject) => {
        channel.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            resolve();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            reject(err ?? new Error(`Realtime subscription failed: ${status}`));
          }
        });
      });

      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discussionId, promptText }),
      });
      const body = await response.json();
      setResult(JSON.stringify(body, null, 2));

      if (response.ok) {
        // The draft was just promoted into a real cell — clear its
        // persisted copy so switching away and back doesn't resurrect
        // it. Best-effort: a failure here shouldn't overwrite the run's
        // own result with an unrelated cleanup error.
        try {
          await fetch(`/api/discussions?id=${discussionId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ draftPromptText: null }),
          });
        } catch {
          // Best-effort cleanup — see comment above.
        }
      }
    } catch (err) {
      setResult(String(err));
    } finally {
      setLoading(false);
      setIsStreaming(false);
      await supabase.removeChannel(channel);
    }
  }

  return (
    <main>
      <h1>Execute tester</h1>
      {discussionId ? (
        <p>Discussion: {discussionId}</p>
      ) : (
        <p>No discussion selected — create or pick one above.</p>
      )}
      {discussionId && history.length > 0 && (
        <div>
          <h2>History</h2>
          {history.map((entry) => (
            <div key={entry.id}>
              <p>
                <strong>Prompt:</strong> {entry.prompt_text}
              </p>
              <p>
                <strong>Response</strong>
                {entry.resolved_model ? ` — ${entry.resolved_model}` : ""}:
              </p>
              <pre>{entry.response}</pre>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={4}
          cols={60}
        />
        <br />
        <button type="submit" disabled={loading || !discussionId}>
          {loading ? "Running..." : "Run"}
        </button>
      </form>
      {streamedResponse !== null && (
        <div>
          <h2>
            Live response{isStreaming ? " (streaming...)" : ""}
            {streamedModel ? ` — ${streamedModel}` : ""}
          </h2>
          <pre>{streamedResponse}</pre>
        </div>
      )}
      {result && <pre>{result}</pre>}
    </main>
  );
}
