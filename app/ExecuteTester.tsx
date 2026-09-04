"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

export function ExecuteTester({ discussionId }: { discussionId: string }) {
  const [promptText, setPromptText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState<string | null>(null);
  const [streamedModel, setStreamedModel] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
      <p>Discussion: {discussionId}</p>
      <form onSubmit={handleSubmit}>
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          rows={4}
          cols={60}
        />
        <br />
        <button type="submit" disabled={loading}>
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
