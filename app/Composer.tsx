"use client";

// The existing composer form (textarea + Run button), unchanged in
// behavior — only its position moves, into the fixed-layout shell's
// composer region (Workspace.tsx), matching pact-mac's actual App.tsx
// structure and the reference screenshot: fixed near the top of the main
// panel, below the header, above the scrolling discussion content. The
// real rich-text/mixed text-image composer rebuild (3.13 decision 1) is a
// separate, standalone prototype outside pact-web — not this component.

export function Composer({
  discussionId,
  promptText,
  setPromptText,
  loading,
  onSubmit,
}: {
  discussionId: string | null;
  promptText: string;
  setPromptText: (value: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit}>
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
  );
}
