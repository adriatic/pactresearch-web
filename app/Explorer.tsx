"use client";

import { useEffect, useState } from "react";

// Phase D's real notebook tree — ports the core behavior of pact-mac's
// Explorer.tsx (reviewed in full per 3.13 development-plan §3.13; the
// 340-line version, not the older 279-line one also found on disk) rather
// than redesigning: per-notebook expand/collapse, discussions nested
// underneath, selecting a discussion drives the active discussionId, and
// the notebook containing the active discussion auto-expands so a
// restored selection is never hidden behind a collapsed row. Deliberately
// not ported: export/import, the isSystem lock icon and hardcoded
// tutorial/drafts notebook IDs (3.13 decision 3's access-rights model
// replaces that, not yet built), persisted expand/collapse state (3.13
// decision 4, deferred — session-only is correct for now), and the inline
// "+ New Discussion" row (NotebookCreator already covers creation).
// Styling stays plain/unstyled, matching this test harness's existing
// convention throughout — "match actual behavior" is read as interaction
// logic, not pact-mac's dark-theme CSS.

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

export function Explorer({
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
  // Session-only — no magic default-expanded IDs (pact-mac hardcodes
  // "notebook-tutorial"/"notebook-general"; that's exactly the
  // special-casing 3.13 decision 3's future access-rights model replaces,
  // not yet built here). Every notebook starts collapsed.
  const [expandedNotebooks, setExpandedNotebooks] = useState<
    Record<string, boolean>
  >({});

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

  // A restored/selected discussion must never be invisible behind a
  // collapsed triangle — ports pact-react-v3's fix for the same gap.
  // Adjusted directly during render (same pattern used elsewhere in this
  // app for "react to a prop/data change"; an effect calling setState
  // synchronously in its body here would trigger an avoidable extra
  // render pass — react-hooks/set-state-in-effect). Tracked against a
  // "handled" id rather than running on every render: if discussions
  // hasn't finished loading yet when activeDiscussionId first changes,
  // the lookup below finds nothing and this deliberately doesn't mark
  // itself handled, so it retries once discussions arrives — but once
  // handled, a later manual collapse by the user isn't fought.
  const [autoExpandedForDiscussionId, setAutoExpandedForDiscussionId] =
    useState<string | null>(null);
  if (activeDiscussionId !== autoExpandedForDiscussionId) {
    const discussion = discussions.find((d) => d.id === activeDiscussionId);
    if (discussion) {
      setAutoExpandedForDiscussionId(activeDiscussionId);
      if (!expandedNotebooks[discussion.notebook_id]) {
        setExpandedNotebooks((prev) => ({
          ...prev,
          [discussion.notebook_id]: true,
        }));
      }
    }
  }

  function toggleNotebook(notebookId: string) {
    setExpandedNotebooks((prev) => ({
      ...prev,
      [notebookId]: !prev[notebookId],
    }));
  }

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
      <h2>Explorer</h2>
      {deleteError && <p>{deleteError}</p>}
      {groups.map((group) => {
        const isExpanded = expandedNotebooks[group.notebookId] ?? false;

        return (
          <div key={group.notebookId}>
            <h3>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  toggleNotebook(group.notebookId);
                }}
              >
                {isExpanded ? "▼" : "▶"} {group.notebookName}
              </a>{" "}
              <button type="button" onClick={() => handleDeleteNotebook(group)}>
                Delete notebook
              </button>
            </h3>
            {isExpanded &&
              (group.discussions.length > 0 ? (
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
              ))}
          </div>
        );
      })}
    </section>
  );
}
