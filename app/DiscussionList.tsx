"use client";

import { useEffect, useState } from "react";

interface Discussion {
  id: string;
  notebook_id: string;
  name: string | null;
  notebooks: { name: string | null } | null;
}

interface NotebookGroup {
  notebookId: string;
  notebookName: string;
  discussions: Discussion[];
}

// Groups the flat, already created_at-desc-sorted list by notebook_id,
// preserving the order notebooks are first encountered in — no separate
// notebook-level sort needed.
function groupByNotebook(discussions: Discussion[]): NotebookGroup[] {
  const groups: NotebookGroup[] = [];
  const groupByNotebookId = new Map<string, NotebookGroup>();

  for (const discussion of discussions) {
    let group = groupByNotebookId.get(discussion.notebook_id);
    if (!group) {
      group = {
        notebookId: discussion.notebook_id,
        notebookName: discussion.notebooks?.name || discussion.notebook_id,
        discussions: [],
      };
      groupByNotebookId.set(discussion.notebook_id, group);
      groups.push(group);
    }
    group.discussions.push(discussion);
  }

  return groups;
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
  const [discussions, setDiscussions] = useState<Discussion[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetchDiscussions().then((body) => {
      if (!cancelled) setDiscussions(body);
    });

    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  async function handleDeleteNotebook(group: NotebookGroup) {
    const confirmed = window.confirm(
      `Delete notebook "${group.notebookName}" and all its discussions? This cannot be undone.`,
    );
    if (!confirmed) return;

    const response = await fetch(`/api/notebooks?id=${group.notebookId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      onNotebookDeleted(
        group.notebookId,
        group.discussions.map((d) => d.id),
      );
    }
  }

  const groups = groupByNotebook(discussions);

  return (
    <section>
      <h2>Discussions</h2>
      {groups.map((group) => (
        <div key={group.notebookId}>
          <h3>
            {group.notebookName}{" "}
            <button type="button" onClick={() => handleDeleteNotebook(group)}>
              Delete notebook
            </button>
          </h3>
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
        </div>
      ))}
    </section>
  );
}
