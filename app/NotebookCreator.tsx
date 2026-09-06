"use client";

import { useState } from "react";

const CATEGORIES = ["Personal Research", "Dev Test"] as const;

export function NotebookCreator({
  onDiscussionCreated,
}: {
  onDiscussionCreated: (discussionId: string) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(
    CATEGORIES[0],
  );
  const [notebookResult, setNotebookResult] = useState<string | null>(null);
  const [notebookLoading, setNotebookLoading] = useState(false);
  const [notebookId, setNotebookId] = useState<string | null>(null);

  const [discussionName, setDiscussionName] = useState("");
  const [discussionResult, setDiscussionResult] = useState<string | null>(null);
  const [discussionLoading, setDiscussionLoading] = useState(false);

  async function handleCreateNotebook(e: React.FormEvent) {
    e.preventDefault();
    setNotebookLoading(true);
    setNotebookResult(null);
    setNotebookId(null);

    try {
      const response = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, category }),
      });
      const body = await response.json();
      setNotebookResult(JSON.stringify(body, null, 2));
      if (response.ok) {
        setNotebookId(body.id);
      }
    } catch (err) {
      setNotebookResult(String(err));
    } finally {
      setNotebookLoading(false);
    }
  }

  async function handleCreateDiscussion(e: React.FormEvent) {
    e.preventDefault();
    if (!notebookId) return;
    setDiscussionLoading(true);
    setDiscussionResult(null);

    try {
      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId, name: discussionName }),
      });
      const body = await response.json();
      setDiscussionResult(JSON.stringify(body, null, 2));
      if (response.ok) {
        onDiscussionCreated(body.id);
      }
    } catch (err) {
      setDiscussionResult(String(err));
    } finally {
      setDiscussionLoading(false);
    }
  }

  return (
    <section>
      <h1>Notebook creator</h1>
      <form onSubmit={handleCreateNotebook}>
        <label>
          Name:{" "}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <br />
        <label>
          Category:{" "}
          <select
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as (typeof CATEGORIES)[number])
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <br />
        <button type="submit" disabled={notebookLoading}>
          {notebookLoading ? "Creating..." : "Create notebook"}
        </button>
      </form>
      {notebookResult && <pre>{notebookResult}</pre>}

      {notebookId && (
        <>
          <h2>Add a discussion to this notebook</h2>
          <p>Notebook: {notebookId}</p>
          <form onSubmit={handleCreateDiscussion}>
            <label>
              Name:{" "}
              <input
                type="text"
                value={discussionName}
                onChange={(e) => setDiscussionName(e.target.value)}
                required
              />
            </label>
            <br />
            <button type="submit" disabled={discussionLoading}>
              {discussionLoading ? "Creating..." : "Create discussion"}
            </button>
          </form>
          {discussionResult && <pre>{discussionResult}</pre>}
        </>
      )}
    </section>
  );
}
