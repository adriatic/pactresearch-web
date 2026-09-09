"use client";

import { useEffect, useState } from "react";

interface Notebook {
  id: string;
  name: string | null;
}

interface Discussion {
  id: string;
  notebook_id: string;
  name: string | null;
}

interface NotebookGroup {
  notebookId: string;
  notebookName: string;
  discussions: Discussion[];
}

// Every notebook gets a group, in the order notebooks were fetched
// (created_at descending) — not derived from discussions, since a notebook
// with zero discussions has none to derive a heading from otherwise. Each
// discussion is then attached to its notebook's group.
function groupByNotebook(
  notebooks: Notebook[],
  discussions: Discussion[],
): NotebookGroup[] {
  const groupByNotebookId = new Map<string, NotebookGroup>();
  const groups: NotebookGroup[] = [];

  for (const notebook of notebooks) {
    const group: NotebookGroup = {
      notebookId: notebook.id,
      notebookName: notebook.name || notebook.id,
      discussions: [],
    };
    groupByNotebookId.set(notebook.id, group);
    groups.push(group);
  }

  for (const discussion of discussions) {
    groupByNotebookId.get(discussion.notebook_id)?.discussions.push(discussion);
  }

  return groups;
}

function fetchNotebooks(): Promise<Notebook[]> {
  return fetch("/api/notebooks").then((response) => response.json());
}

function fetchDiscussions(): Promise<Discussion[]> {
  return fetch("/api/discussions").then((response) => response.json());
}

export function DiscussionList({
  activeDiscussionId,
  onSelect,
  onNotebookDeleted,
  refetchToken,
}: {
  activeDiscussionId: string | null;
  onSelect: (discussionId: string) => void;
  onNotebookDeleted: (
    notebookId: string,
    deletedDiscussionIds: string[],
  ) => void;
  refetchToken: number;
}) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchNotebooks(), fetchDiscussions()]).then(
      ([notebooksBody, discussionsBody]) => {
        if (!cancelled) {
          setNotebooks(notebooksBody);
          setDiscussions(discussionsBody);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  async function handleDeleteNotebook(group: NotebookGroup) {
    const confirmed = window.confirm(
      `Delete notebook "${group.notebookName}" and all its discussions? This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleteError(null);
    const response = await fetch(`/api/notebooks?id=${group.notebookId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      onNotebookDeleted(
        group.notebookId,
        group.discussions.map((d) => d.id),
      );
    } else if (response.status === 409) {
      setDeleteError(
        `"${group.notebookName}" can't be deleted right now — a discussion in it is actively executing. Try again once that finishes.`,
      );
    } else {
      setDeleteError(`Failed to delete "${group.notebookName}".`);
    }
  }

  const groups = groupByNotebook(notebooks, discussions);

  return (
    <section>
      <h2>Discussions</h2>
      {deleteError && <p>{deleteError}</p>}
      {groups.map((group) => (
        <div key={group.notebookId}>
          <h3>
            {group.notebookName}{" "}
            <button type="button" onClick={() => handleDeleteNotebook(group)}>
              Delete notebook
            </button>
          </h3>
          {group.discussions.length > 0 ? (
            <ul>
              {group.discussions.map((discussion) => (
                <li key={discussion.id}>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onSelect(discussion.id);
                    }}
                    style={
                      discussion.id === activeDiscussionId
                        ? { fontWeight: "bold" }
                        : undefined
                    }
                  >
                    {discussion.name || discussion.id}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>No discussions yet.</p>
          )}
        </div>
      ))}
    </section>
  );
}
