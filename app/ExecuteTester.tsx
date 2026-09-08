"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

interface PastResponse {
  id: string;
  prompt_text: string;
  response: string | null;
  resolved_model: string | null;
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

  // Clears every piece of state that describes the *currently active*
  // discussion — not just the live-run display — when discussionId itself
  // changes: a different discussion picked, a new one created, or the
  // active one cleared entirely (e.g. after a delete). history was added by
  // an earlier task and missed this reset the first time around; it
  // belongs here for the same reason the other four do. (promptText and
  // loading are deliberately not included — promptText is the user's own
  // draft input, not discussion-derived data, and loading is a live
  // in-flight flag rather than a data cache; forcibly clearing it while a
  // request for the old discussion is still genuinely running would be
  // misleading, not corrective.) Adjusted directly during render, same
  // pattern as NotebookCreator's deleted-notebook clear: an effect calling
  // setState synchronously in its body here would trigger an avoidable
  // extra render pass (react-hooks/set-state-in-effect).
  const [displayedDiscussionId, setDisplayedDiscussionId] =
    useState(discussionId);
  if (discussionId !== displayedDiscussionId) {
    setDisplayedDiscussionId(discussionId);
    setResult(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setIsStreaming(false);
    setHistory([]);
  }

  useEffect(() => {
    if (!discussionId) return;

    let cancelled = false;

    fetch(`/api/responses?discussionId=${discussionId}`)
      .then((response) => response.json())
      .then((body) => {
        if (!cancelled) setHistory(body);
      });

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
