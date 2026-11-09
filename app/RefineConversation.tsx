"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { LlmProviderId } from "@/lib/llmProviders";
import {
  latestPrompt,
  extractPrompt,
  REFINE_INCOMPLETE_NOTE,
  REFINE_LOADING_NOTE,
  refineAtLimit,
  refineMessageLabel,
  refineProviderLabel,
  refineWords,
  replySegments,
  type RefineMessage,
} from "@/lib/refineConversation";

// Task D17e. "Refine with AI" as a conversation: the assistant asks one
// question at a time, then writes a system prompt between two marker
// lines, which "Use this prompt" copies into the dialog's System prompt
// field. Design: cc-reports summary-task-D17a-refine-design.md, section 4.
// Pure parts live in lib/refineConversation.ts; the route is
// /api/refine-conversation (D17d).
//
// Two ways to use it, so the New Notebook dialog (D17f) can take it as it
// is:
//   notebookId set    the conversation is the notebook's own, on the
//                     server: loaded with GET when this mounts, each turn
//                     stored by POST, "Start over" is DELETE.
//   notebookId null   there is no notebook yet: the conversation lives in
//                     this component's state, POST stores nothing, and
//                     onConversationChange hands every change to the
//                     parent (to PUT once the notebook exists).
//
// provider is the account's own service (Workspace's useLlmChoice, the
// same value the header's Provider dropdown shows). The route reads the
// same user_metadata.llm_provider, so the name in the explanation and in
// "… is writing…" is the service that answers. Each reply is labelled by
// the provider stored on it, not by this prop.
//
// Task D17i. The unsent message survives closing the dialog: the parent
// holds it in memory (initialDraft, onDraftChange) and hands it back when
// this mounts again. Nothing is written anywhere. onDraftChange gets every
// edit and "" after a confirmed Start over. While a message is on its way
// the parent keeps holding it, so a failed send needs nothing more (and
// it is there even if the dialog was closed meanwhile). A successful send
// clears it only if the parent still holds that same text, so an answer
// arriving after the dialog was closed and reopened never wipes what was
// typed since. The draft is read only when this mounts, so it can never
// replace what is typed afterwards.

const HISTORY_HEIGHT = 220;
// Nik's iPad: buttons at least 44px tall (ContextDialog, AccountDialog).
const TOUCH = 44;

const line = (color: string) =>
  ({
    margin: "4px 0 0",
    color,
    fontSize: "0.85em",
    overflowWrap: "anywhere",
  }) as const;

export function RefineConversation({
  notebookId,
  provider,
  onUsePrompt,
  usedNote = "Copied into the System prompt field. Save to keep it.",
  disabled = false,
  onConversationChange,
  initialDraft = "",
  onDraftChange,
}: {
  notebookId: string | null;
  provider: LlmProviderId;
  // Replaces the parent's System prompt field.
  onUsePrompt: (prompt: string) => void;
  // The line shown after "Use this prompt" (New Notebook says "Create the
  // notebook to keep it." instead).
  usedNote?: string;
  // The parent is busy (loading, saving, creating): nothing can be sent
  // and no prompt used. Typing still works (Task D17e2).
  disabled?: boolean;
  onConversationChange?: (messages: RefineMessage[]) => void;
  // Task D17i: the unsent message the parent holds for this conversation.
  initialDraft?: string;
  // onlyIf: change it only if the held text is still exactly this.
  onDraftChange?: (text: string, onlyIf?: string) => void;
}) {
  const [messages, setMessages] = useState<RefineMessage[]>([]);
  // A notebook's conversation is unknown until GET answers; nothing can
  // be sent before, or the stored one would be overwritten.
  const [loaded, setLoaded] = useState(notebookId === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState(initialDraft);
  // The message on its way: shown at once, taken back on an error.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const explanationId = useId();

  const label = refineProviderLabel(provider);

  // What the user typed: shown, and handed to the parent to keep.
  function setDraft(text: string) {
    setInput(text);
    onDraftChange?.(text);
  }

  function change(next: RefineMessage[]) {
    setMessages(next);
    onConversationChange?.(next);
  }

  useEffect(() => {
    if (notebookId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/refine-conversation?notebookId=${encodeURIComponent(notebookId)}`,
        );
        const body = await response.json();
        if (cancelled) return;
        if (response.ok && Array.isArray(body.messages)) {
          setMessages(body.messages);
          setLoaded(true);
          // A stored conversation the route could not read (D17e2).
          if (body.notice?.error) setNotice(body.notice.error);
        } else {
          setLoadError(body.error || refineWords("network", provider).error);
        }
      } catch {
        if (!cancelled) setLoadError(refineWords("network", provider).error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // provider only picks the words of a failed load; a change must not
    // load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  // Kept scrolled to the newest message.
  const shownCount = messages.length + (pending === null ? 0 : 1);
  useEffect(() => {
    const box = historyRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [shownCount]);

  const waiting = pending !== null;
  const atLimit = refineAtLimit(messages);
  // Task D17e2. Typing is closed only by what the dialog says in words:
  // the conversation still loading ("Loading the conversation…") or
  // failed to load (the error), the limit (its words below), a reply on
  // its way ("… is writing…") or a Start over in progress. A busy parent
  // (the dialog loading or saving its System prompt) only holds back
  // sending: before, it also disabled the textarea, with nothing on the
  // screen to say why.
  const canType = loaded && !loadError && !waiting && !deleting && !atLimit;
  const canSend = canType && !disabled;
  const found = latestPrompt(messages);
  const last = messages.at(-1);
  const incomplete =
    !waiting &&
    last?.role === "assistant" &&
    extractPrompt(last.content).incomplete;

  async function send() {
    const text = input.trim();
    if (!text || !canSend) return;
    const typed = input;
    const sent: RefineMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setPending(text);
    setInput("");
    setError(null);
    setNotice(null);
    setUsed(false);
    setConfirming(false);
    try {
      const response = await fetch("/api/refine-conversation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId, messages: sent }),
      });
      const body = await response.json();
      if (response.ok && Array.isArray(body.messages)) {
        change(body.messages);
        if (body.notice?.error) setNotice(body.notice.error);
        // Sent: nothing is held any more, unless it was retyped since.
        onDraftChange?.("", typed);
      } else {
        setInput(typed);
        setError(body.error || refineWords("provider_error", provider).error);
      }
    } catch {
      setInput(typed);
      setError(refineWords("network", provider).error);
    } finally {
      setPending(null);
    }
  }

  async function startOver() {
    setDeleting(true);
    setError(null);
    try {
      if (notebookId !== null) {
        const response = await fetch(
          `/api/refine-conversation?notebookId=${encodeURIComponent(notebookId)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setError(body.error || refineWords("network", provider).error);
          return;
        }
      }
      change([]);
      // Task D17i: a fresh start drops the unsent message too.
      setDraft("");
      setConfirming(false);
      setNotice(null);
      setUsed(false);
    } catch {
      setError(refineWords("network", provider).error);
    } finally {
      setDeleting(false);
    }
  }

  const shown: RefineMessage[] =
    pending === null
      ? messages
      : [...messages, { role: "user", content: pending }];

  return (
    <div data-refine-conversation style={{ marginBottom: 8 }}>
      <label htmlFor={inputId} style={{ display: "block" }}>
        Refine with AI
      </label>
      <p id={explanationId} style={{ ...line("var(--text-muted)") }}>
        Answer a few questions and {label} will write a system prompt for this
        notebook.
      </p>

      {shown.length > 0 && (
        <div
          ref={historyRef}
          role="log"
          aria-label="Refine with AI conversation"
          data-refine-history
          style={{
            marginTop: 8,
            height: HISTORY_HEIGHT,
            overflowY: "auto",
            overflowX: "hidden",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 8,
            boxSizing: "border-box",
          }}
        >
          {shown.map((message, index) => (
            <Message key={index} message={message} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <textarea
          id={inputId}
          aria-describedby={explanationId}
          rows={2}
          value={input}
          placeholder={
            messages.length === 0
              ? "Describe your research domain…"
              : "Answer the question…"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line. Not while an input
            // method is composing a character.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={!canType}
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <button
          type="button"
          aria-label="Send"
          title="Send"
          onClick={() => void send()}
          disabled={!canSend || !input.trim()}
          style={{ minHeight: TOUCH, minWidth: TOUCH, alignSelf: "flex-end" }}
        >
          →
        </button>
      </div>

      {(found || messages.length > 0) && !waiting && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
          }}
        >
          {found && (
            <button
              type="button"
              onClick={() => {
                onUsePrompt(found.prompt);
                setUsed(true);
              }}
              disabled={disabled}
              style={{ minHeight: TOUCH }}
            >
              Use this prompt
            </button>
          )}
          {messages.length > 0 && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={disabled || deleting}
              style={{
                marginLeft: "auto",
                minHeight: TOUCH,
                padding: "0 4px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                textDecoration: "underline",
                fontSize: "0.85em",
              }}
            >
              Start over
            </button>
          )}
        </div>
      )}

      {confirming && (
        <div
          role="group"
          aria-label="Start over"
          style={{ ...line("var(--foreground)"), marginTop: 8 }}
        >
          Start a new conversation? The current one will be deleted.
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => void startOver()}
              disabled={deleting}
              style={{ minHeight: TOUCH }}
            >
              Start over
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              style={{ minHeight: TOUCH }}
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {waiting && (
        <p role="status" style={line("var(--text-muted)")}>
          {label} is writing…
        </p>
      )}
      {!loaded && !loadError && (
        <p role="status" style={line("var(--text-muted)")}>
          {REFINE_LOADING_NOTE}
        </p>
      )}
      {loadError && (
        <p role="alert" style={line("var(--danger)")}>
          {loadError}
        </p>
      )}
      {error && (
        <p role="alert" style={line("var(--danger)")}>
          {error}
        </p>
      )}
      {notice && (
        <p role="alert" style={line("var(--danger)")}>
          {notice}
        </p>
      )}
      {incomplete && (
        <p style={line("var(--text-muted)")}>{REFINE_INCOMPLETE_NOTE}</p>
      )}
      {atLimit && !waiting && (
        <p style={line("var(--text-muted)")}>
          {refineWords("too_many_messages", provider).error}
        </p>
      )}
      {used && (
        <p role="status" style={line("var(--success)")}>
          {usedNote}
        </p>
      )}
    </div>
  );
}

// One message: who wrote it, then its text; a marked prompt in its own
// box.
function Message({ message }: { message: RefineMessage }) {
  const who =
    message.role === "user"
      ? "You"
      : (refineMessageLabel(message) ?? "Assistant");
  const segments =
    message.role === "assistant"
      ? replySegments(message.content)
      : [{ kind: "text" as const, text: message.content }];
  return (
    <div data-refine-message={message.role} style={{ marginBottom: 10 }}>
      <div
        data-refine-label
        style={{ color: "var(--text-muted)", fontSize: "0.8em" }}
      >
        {who}
      </div>
      {segments.map((segment, index) =>
        segment.kind === "prompt" ? (
          <div
            key={index}
            data-refine-prompt
            style={{
              margin: "4px 0",
              padding: 8,
              background: "var(--button-bg)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--foreground)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {segment.text}
          </div>
        ) : (
          <div
            key={index}
            style={{
              color: "var(--foreground)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {segment.text}
          </div>
        ),
      )}
    </div>
  );
}
