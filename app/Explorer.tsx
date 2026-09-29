"use client";

import { useEffect, useRef, useState } from "react";
import {
  syncDataLoaderFeature,
  hotkeysCoreFeature,
  type TreeState,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { RowMenu } from "./RowMenu";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import {
  AddDiscussionDialog,
  type AddDiscussionTarget,
} from "./AddDiscussionDialog";
import type { ActivityRollup } from "@/lib/activityRollup";
import { formatRollupTotal } from "@/lib/formatActivity";

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
//
// Follow-up to 220474c: the hand-rolled "▼"/"▶" text-triangle link was
// unusable for real evaluation — no real tree control, no keyboard nav,
// no visual hierarchy. Rather than hand-build a real one, this uses
// @headless-tree (core + react bindings) — evaluated against
// react-arborist (pulls in redux + react-dnd, unneeded weight for a
// drag-free 2-level tree), react-accessible-treeview (its own README
// opens with "SEEKING NEW MAINTAINERS" — not actually well-maintained
// despite download counts), and react-complex-tree (headless-tree is
// that library's own official successor, from the same author). Chosen
// for: zero runtime dependencies, genuinely headless (no imposed CSS —
// this project has no CSS framework), and active development. Its
// "beta" label is a real caveat, worth noting, but beta-and-actively-
// developed beat stable-but-orphaned here. Delete controls' visual
// treatment is still explicitly out of scope for this task.

interface Notebook {
  id: string;
  name: string | null;
}

interface Discussion {
  id: string;
  notebook_id: string;
  name: string | null;
}

type TreeNodeData =
  | { kind: "root" }
  | { kind: "notebook"; notebookId: string; name: string }
  | {
      kind: "discussion";
      discussionId: string;
      notebookId: string;
      name: string;
    }
  | { kind: "empty-placeholder" };

function fetchNotebooks(): Promise<Notebook[]> {
  return fetch("/api/notebooks").then((response) => response.json());
}

function fetchDiscussions(): Promise<Discussion[]> {
  return fetch("/api/discussions").then((response) => response.json());
}

const ROOT_ID = "__explorer_root__";

// Session-only expand/collapse persistence: survives a same-tab reload
// (this bug's actual bar — it didn't even do that before) without
// reaching for the database or surviving across tabs/devices, which
// stays out of scope per 3.13 decision 4. sessionStorage rather than
// localStorage specifically because it's scoped to the one tab/session.
const EXPANDED_ITEMS_STORAGE_KEY = "pact:explorer:expandedItems";

function readPersistedExpandedItems(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function persistExpandedItems(expandedItems: string[]) {
  try {
    window.sessionStorage.setItem(
      EXPANDED_ITEMS_STORAGE_KEY,
      JSON.stringify(expandedItems),
    );
  } catch {
    // Best-effort — a full session store or disabled storage shouldn't
    // break the tree itself, just the persistence of its state.
  }
}

export function Explorer({
  activeDiscussionId,
  selectedNotebookId,
  onSelect,
  onNotebookSelected,
  onNotebookDeleted,
  onDiscussionDeleted,
  onDiscussionRenamed,
  onDiscussionCreated,
  isRunning,
  refetchToken,
}: {
  activeDiscussionId: string | null;
  // The notebook NotebookCreator's "Add a discussion to this notebook"
  // currently targets (Workspace's own state, driven by whichever
  // notebook/discussion the user actually clicked) -- rendered here only
  // to give that selection a visible indicator in the tree itself, which
  // it previously had none of.
  selectedNotebookId: string | null;
  // notebookId is the discussion's own parent -- selecting a discussion
  // also selects the notebook it lives in, so "Add a discussion to this
  // notebook" targets the right one even if the user never separately
  // clicked the notebook row itself.
  onSelect: (discussionId: string, notebookId: string) => void;
  onNotebookSelected: (notebookId: string) => void;
  onNotebookDeleted: (
    notebookId: string,
    deletedDiscussionIds: string[],
  ) => void;
  onDiscussionDeleted: (discussionId: string) => void;
  // Task 54. Only discussions need this: the header shows the active
  // discussion's name, and nothing outside this tree renders a
  // notebook's name, so a notebook rename is purely local state here.
  onDiscussionRenamed: (discussionId: string, name: string) => void;
  // Task 60. Adding a discussion moved into the row menu, so Explorer
  // now needs the same callback NotebookCreator used to own -- it
  // selects the new discussion and refetches the tree.
  onDiscussionCreated: (discussionId: string) => void;
  // Task 63. The same `loading` the Run button and ComposerHeader's
  // status dot already use. Not for rendering here -- purely so the
  // per-notebook rollups refetch when a run FINISHES, which is the one
  // moment they change and the one moment nothing told this tree.
  isRunning: boolean;
  refetchToken: number;
}) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  // Task 60. Which notebook the "Add discussion" dialog is open for.
  const [addTarget, setAddTarget] = useState<AddDiscussionTarget | null>(null);
  // Task 55c. Per-notebook rollups, keyed by notebook id. Fetched in one
  // request rather than one per row, and re-fetched on the same token
  // the tree itself uses -- a rollup is derived from discussions and
  // runs, so it is stale exactly when the tree is.
  const [notebookRollups, setNotebookRollups] = useState<
    Record<string, ActivityRollup>
  >({});
  // Which discussion (at most one -- execution_locks is keyed by user_id,
  // one lock per user, not per discussion) the signed-in user currently
  // has running, regardless of which discussion is active in Workspace --
  // a run left executing after switching away from it previously looked
  // identical to an idle discussion in this tree. Polled rather than tied
  // to refetchToken: a run starting/finishing doesn't bump that token
  // today, and adding that wiring through Workspace/useDiscussionExecution
  // would be a bigger change than this fix calls for.
  const [executingDiscussionId, setExecutingDiscussionId] = useState<
    string | null
  >(null);

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

    // Rollups are display-only: a failure here must leave the tree
    // working, so this neither blocks the fetch above nor surfaces an
    // error. A row simply shows no timing rather than the tree
    // refusing to render.
    fetch("/api/activity-rollups")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { notebooks?: Record<string, ActivityRollup> } | null) => {
        if (!cancelled && body?.notebooks) setNotebookRollups(body.notebooks);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // isRunning as well as refetchToken, and this is task 63's actual
    // fix. refetchToken bumps when the tree's STRUCTURE changes --
    // create, delete, import -- and a completed run changes none of
    // that. So the rollups were fetched once at page load and never
    // again: run three prompts and the tree still reported whatever
    // was true before you started, which for a fresh notebook is
    // "No runs yet".
    //
    // Reported as "rename breaks the rollup", and the rename was
    // innocent -- verified by rolling up the same notebook either side
    // of a PATCH and getting identical numbers. Renaming just drew the
    // eye to a row that had been stale since load.
    //
    // ComposerHeader already keyed its own rollup on isRunning for
    // exactly this reason (task 55c); the tree was left behind.
  }, [refetchToken, isRunning]);

  // 3s poll: frequent enough that "still running" feels live without
  // hammering the DB for what's ultimately a single small row read,
  // scoped to the caller's own lock by RLS. Runs independently of
  // refetchToken/mount-only effects above -- this needs to keep noticing
  // a run finish even while nothing else about the tree changes.
  useEffect(() => {
    let cancelled = false;
    function poll() {
      fetch("/api/execution-locks")
        .then((response) => response.json())
        .then((body: { discussionId: string | null }) => {
          if (!cancelled) setExecutingDiscussionId(body.discussionId);
        })
        .catch(() => {
          // Best-effort -- a failed poll just leaves the last-known
          // state on screen until the next tick succeeds.
        });
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleDeleteNotebook(notebookId: string, name: string) {
    // Computed BEFORE the prompt so the message can state the blast
    // radius. "and all its discussions" was true but vague: deleting a
    // notebook with eleven discussions and one with none read
    // identically, and the number is the part that makes someone stop
    // and think.
    //
    // Counted from the tree's own loaded state, the same source the
    // callback below already uses for deletedDiscussionIds. That can
    // lag a discussion added in another tab, so this is an honest
    // indication of scale rather than a guarantee -- the server
    // deletes whatever is actually there, via ON DELETE CASCADE.
    const deletedDiscussionIds = discussions
      .filter((d) => d.notebook_id === notebookId)
      .map((d) => d.id);
    const count = deletedDiscussionIds.length;
    const blastRadius =
      count === 0
        ? "It has no discussions."
        : `This will also delete its ${count} discussion${count === 1 ? "" : "s"}.`;

    const confirmed = window.confirm(
      `Delete notebook "${name}"?\n\n${blastRadius} This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleteError(null);
    const response = await fetch(`/api/notebooks?id=${notebookId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      onNotebookDeleted(notebookId, deletedDiscussionIds);
    } else if (response.status === 409) {
      setDeleteError(
        `"${name}" can't be deleted right now — a discussion in it is actively executing. Try again once that finishes.`,
      );
    } else {
      setDeleteError(`Failed to delete "${name}".`);
    }
  }

  // Downloads the notebook as a .pact file -- a plain JSON file (ported
  // from pact-mac's export format, unsigned, minus desktop-only xmState)
  // that importNotebook() can turn back into a fully independent notebook
  // instance. The file itself is fetched and blobbed client-side rather
  // than navigated to directly, matching every other action in this
  // component being a fetch() call.
  // Task 54. Returns an error message for the dialog to show, or null
  // on success -- the dialog stays open and keeps what was typed when
  // the server rejects it, rather than closing and losing the edit.
  //
  // On success the row is updated in local state rather than by
  // refetching the whole tree: a refetch would rebuild every item and
  // collapse nothing visibly but cost a round trip to change one
  // string. The name is taken from the server's response, not from
  // what was typed, so the tree shows what was actually stored (the
  // route trims).
  async function handleRename(
    target: RenameTarget,
    newName: string,
  ): Promise<string | null> {
    const endpoint =
      target.kind === "notebook" ? "/api/notebooks" : "/api/discussions";
    let body: { name?: string | null; error?: string };
    try {
      const response = await fetch(`${endpoint}?id=${target.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      body = await response.json();
      if (!response.ok) {
        return body.error || `Failed to rename "${target.name}".`;
      }
    } catch {
      return `Failed to rename "${target.name}" — please try again.`;
    }

    const stored = body.name ?? newName;
    if (target.kind === "notebook") {
      setNotebooks((current) =>
        current.map((notebook) =>
          notebook.id === target.id ? { ...notebook, name: stored } : notebook,
        ),
      );
    } else {
      setDiscussions((current) =>
        current.map((discussion) =>
          discussion.id === target.id
            ? { ...discussion, name: stored }
            : discussion,
        ),
      );
      // The header renders the active discussion's name from its own
      // state (useDiscussionExecution loads it with the discussion), so
      // renaming the one that's open has to reach it -- otherwise the
      // tree and the header disagree until the next switch.
      onDiscussionRenamed(target.id, stored);
    }
    setRenameTarget(null);
    return null;
  }

  async function handleExportNotebook(notebookId: string, name: string) {
    setExportError(null);
    const response = await fetch(`/api/notebooks/export?id=${notebookId}`);
    if (!response.ok) {
      setExportError(`Failed to export "${name}".`);
      return;
    }
    const pactExport = await response.json();
    const blob = new Blob([JSON.stringify(pactExport, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // Same sanitization concern as any user-provided string ending up in
    // a filename -- strip anything that isn't safe across filesystems,
    // collapse the rest to single hyphens.
    const safeName = name
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    link.download = `${safeName || "notebook"}.pact`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Task 65. Per-discussion export, and deliberately not a .pact file:
  // markdown, because a single discussion someone exports is usually
  // headed for an email or a doc rather than back into pact-web. The
  // server does the rendering and names the file, so the convention
  // lives in one place (lib/discussionMarkdown.ts).
  async function handleExportDiscussion(discussionId: string, name: string) {
    setExportError(null);
    const response = await fetch(
      `/api/discussions/export?id=${encodeURIComponent(discussionId)}`,
    );
    if (!response.ok) {
      setExportError(`Failed to export "${name}".`);
      return;
    }
    const { filename, markdown } = await response.json();
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Per-discussion counterpart to handleDeleteNotebook above. The 409 it
  // can get back is about *this* discussion's own active execution lock
  // (DELETE /api/discussions), not the notebook-level "some discussion in
  // here is executing" check — deleting one discussion is never blocked
  // by a sibling's run.
  async function handleDeleteDiscussion(discussionId: string, name: string) {
    const confirmed = window.confirm(
      `Delete discussion "${name}" and all its responses? This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleteError(null);
    const response = await fetch(`/api/discussions?id=${discussionId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      onDiscussionDeleted(discussionId);
    } else if (response.status === 409) {
      setDeleteError(
        `"${name}" can't be deleted right now — it's actively executing. Try again once that finishes.`,
      );
    } else {
      setDeleteError(`Failed to delete "${name}".`);
    }
  }

  // Tracks the tree's own last-seen state so setState below can resolve
  // the updater-function form of SetStateFn's Updater<T> union — in
  // practice @headless-tree/react always calls setState with a direct
  // value, never a function, but the declared type allows either.
  const lastTreeStateRef = useRef<Partial<TreeState<TreeNodeData>>>({});

  const tree = useTree<TreeNodeData>({
    rootItemId: ROOT_ID,
    getItemName: (item) => {
      const data = item.getItemData();
      switch (data.kind) {
        case "notebook":
        case "discussion":
          return data.name;
        case "empty-placeholder":
          return "No discussions yet.";
        default:
          return "";
      }
    },
    isItemFolder: (item) => item.getItemData().kind === "notebook",
    dataLoader: {
      getItem: (itemId) => {
        if (itemId === ROOT_ID) return { kind: "root" };
        if (itemId.endsWith("::empty")) return { kind: "empty-placeholder" };
        const notebook = notebooks.find((n) => n.id === itemId);
        if (notebook) {
          return {
            kind: "notebook",
            notebookId: notebook.id,
            // Falls back to a placeholder, never the raw id -- a
            // notebook's own uuid is meaningless to a user and was
            // previously shown here for anything imported from a .pact
            // file with an empty-string name (now rejected at import
            // validation, see lib/pactExport.ts, but this stays as a
            // display-layer guard regardless of how an empty name might
            // reach the database).
            name: notebook.name || "Untitled notebook",
          };
        }
        const discussion = discussions.find((d) => d.id === itemId);
        if (discussion) {
          return {
            kind: "discussion",
            discussionId: discussion.id,
            notebookId: discussion.notebook_id,
            name: discussion.name || "Untitled discussion",
          };
        }
        return { kind: "root" };
      },
      getChildren: (itemId) => {
        if (itemId === ROOT_ID) return notebooks.map((n) => n.id);
        const isNotebook = notebooks.some((n) => n.id === itemId);
        if (!isNotebook) return [];
        const childDiscussionIds = discussions
          .filter((d) => d.notebook_id === itemId)
          .map((d) => d.id);
        // A notebook with zero discussions still gets a row — a synthetic
        // placeholder child rather than an empty children array, since
        // this data model has no other way to render "No discussions
        // yet." under an expanded, empty notebook.
        return childDiscussionIds.length > 0
          ? childDiscussionIds
          : [`${itemId}::empty`];
      },
    },
    indent: 20,
    onPrimaryAction: (item) => {
      const data = item.getItemData();
      // Purely additive to whatever headless-tree's own default handling
      // of this same event already does for a folder item (the
      // expand/collapse toggle) -- nothing here replaces or needs to
      // coordinate with that.
      if (data.kind === "notebook") {
        onNotebookSelected(data.notebookId);
      } else if (data.kind === "discussion") {
        onSelect(data.discussionId, data.notebookId);
      }
    },
    // Seeds expandedItems from sessionStorage on mount (read once, via a
    // lazy initializer, not on every render), then persists it back on
    // every tree state change. This only observes and mirrors
    // expandedItems out to storage — it doesn't take over as the
    // source of truth the way a fully-controlled `state` prop would, so
    // the auto-expand effect below (and the tree's own internal click
    // handling) keep working exactly as before; they still just call
    // item.expand()/collapse() and this tags along.
    initialState: { expandedItems: readPersistedExpandedItems() },
    setState: (updaterOrValue) => {
      const state =
        typeof updaterOrValue === "function"
          ? updaterOrValue(lastTreeStateRef.current)
          : updaterOrValue;
      lastTreeStateRef.current = state;
      if (state.expandedItems) persistExpandedItems(state.expandedItems);
    },
    // Enter/Space fire the exact same primaryAction a click does, for
    // whichever row keyboard focus is currently on -- item.primaryAction()
    // is the same call onClick already makes (see itemInstance.getProps()
    // in @headless-tree/core's main feature), so this can't drift from
    // click behavior. Deliberately NOT also toggling expand/collapse the
    // way a click on a notebook does -- Arrow Left/Right already own
    // expand/collapse for keyboard users, and primaryAction() alone
    // doesn't touch it either, so doubling it up here isn't needed.
    // Two separate entries, not one: HotkeyConfig only matches a single
    // key (or Shift/Ctrl+key combo) per entry, not a list of alternatives.
    hotkeys: {
      customPrimaryActionEnter: {
        hotkey: "enter",
        preventDefault: true,
        handler: (_e, tree) => {
          tree.getFocusedItem()?.primaryAction();
        },
      },
      customPrimaryActionSpace: {
        hotkey: "space",
        preventDefault: true,
        handler: (_e, tree) => {
          tree.getFocusedItem()?.primaryAction();
        },
      },
    },
    // selectionFeature (Ctrl/Shift-click, Ctrl+A, Ctrl+Space, Shift+Arrow)
    // was removed -- it had no visible effect (nothing rendered
    // isSelected()) and its real bug was that a modifier-held click still
    // fired the same primaryAction a plain click does, silently switching
    // the active discussion/target notebook while the user thought they
    // were building a multi-selection. No replacement multi-select
    // feature is wanted (confirmed with Nik) -- a modifier-held click now
    // just does what mainFeature's own click handling already does
    // (focus + primaryAction, skipping the expand/collapse toggle when a
    // modifier is held, same as before), with no separate selection
    // side-effect layered on top.
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });

  // The sync data loader retrieves item/children data once and caches it
  // internally — rebuildTree() is headless-tree's own documented way to
  // tell it the underlying data changed (a notebook/discussion created or
  // deleted) and it should recompute rather than keep showing stale data.
  useEffect(() => {
    tree.rebuildTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebooks, discussions]);

  // A restored/selected discussion must never be invisible behind a
  // collapsed row — ports pact-react-v3's fix for the same gap (first
  // applied in this app's b8ca74e). Split in two: which notebook needs
  // expanding is decided during render (the same "adjust state when a
  // prop changes" pattern used elsewhere in this app), but handed to the
  // effect via *state*, not a local variable — calling setState during
  // render makes React immediately discard and restart that render (its
  // documented behavior for this exact pattern), so a plain local
  // variable computed in the discarded render never survives to reach a
  // committed effect. pendingAutoExpandNotebookId is state specifically
  // so it survives the restart. The actual tree.expand() call is a
  // genuinely imperative call into an external, non-React-state library,
  // which a useEffect is the correct place for — not working around
  // react-hooks/set-state-in-effect, but a real "synchronize with an
  // external system" case. Not reset back to null afterward: the effect
  // is keyed on this value specifically, so it only re-fires when a new
  // auto-expand is genuinely due, whether or not the old value is cleared.
  const [autoExpandedForDiscussionId, setAutoExpandedForDiscussionId] =
    useState<string | null>(null);
  const [pendingAutoExpandNotebookId, setPendingAutoExpandNotebookId] =
    useState<string | null>(null);
  if (activeDiscussionId !== autoExpandedForDiscussionId) {
    const discussion = discussions.find((d) => d.id === activeDiscussionId);
    // discussions hasn't loaded yet — don't mark handled, so this retries
    // once it has (this render-time check re-runs on every render where
    // discussions has changed).
    if (discussion) {
      setAutoExpandedForDiscussionId(activeDiscussionId);
      setPendingAutoExpandNotebookId(discussion.notebook_id);
    }
  }

  useEffect(() => {
    if (!pendingAutoExpandNotebookId) return;
    const notebookItem = tree.getItemInstance(pendingAutoExpandNotebookId);
    if (notebookItem && !notebookItem.isExpanded()) {
      notebookItem.expand();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoExpandNotebookId]);

  return (
    <section>
      <h2>Explorer</h2>
      {deleteError && <p>{deleteError}</p>}
      {exportError && <p>{exportError}</p>}
      <RenameDialog
        target={renameTarget}
        onCancel={() => setRenameTarget(null)}
        onRename={handleRename}
      />
      <AddDiscussionDialog
        target={addTarget}
        onCancel={() => setAddTarget(null)}
        onCreated={(discussionId) => {
          setAddTarget(null);
          onDiscussionCreated(discussionId);
        }}
      />
      <div {...tree.getContainerProps("Explorer")}>
        {tree.getItems().map((item) => {
          const data = item.getItemData();
          const level = item.getItemMeta().level;
          const paddingLeft = 8 + level * 20;

          if (data.kind === "root") return null;

          if (data.kind === "empty-placeholder") {
            return (
              <div
                key={item.getId()}
                style={{
                  padding: `2px 8px 2px ${paddingLeft}px`,
                  color: "#888",
                }}
              >
                No discussions yet.
              </div>
            );
          }

          if (data.kind === "notebook") {
            const isExpanded = item.isExpanded();
            // Same kind of signal as a discussion's bold "active" text,
            // but a background rather than font-weight -- notebook names
            // render as an <h3>, already bold by default, so font-weight
            // alone wouldn't be visible here the way it is on a
            // discussion's plain <span>.
            const isSelected = data.notebookId === selectedNotebookId;
            // Empty string when the rollup has not arrived yet, which
            // renders nothing rather than a flash of "No runs yet" that
            // then changes its mind.
            const rollupText = formatRollupTotal(
              notebookRollups[data.notebookId] ?? null,
            );
            return (
              <div
                key={item.getId()}
                {...item.getProps()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: `4px 8px 4px ${paddingLeft}px`,
                  cursor: "pointer",
                  background: isSelected ? "#dbe9ff" : "transparent",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: "1em", fontSize: "0.75em" }}
                >
                  {isExpanded ? "▼" : "▶"}
                </span>
                <span aria-hidden="true">📓</span>
                {/* Name and rollup stacked, with the heading holding
                    ONLY the name. The rollup lived inside the <h3>
                    first, which made the heading's own text "Alpha\nNo
                    runs yet" -- caught immediately by
                    notebook-export-import.spec.ts reading h3 inner
                    text, and wrong regardless: the heading is the
                    notebook's title, not a place to park metadata. */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ margin: 0, fontSize: "1em" }}>{data.name}</h3>
                  {/* Task 55c. The notebook's measured total.

                      aria-hidden, and that is a real trade rather than
                      an oversight. A treeitem's accessible name is
                      computed from its contents, so text added here
                      lands in it -- and a dozen specs across this suite
                      locate rows with { name, exact: true }, as does
                      anyone navigating the tree by name. Hiding it
                      keeps row identity stable and keeps timing out of
                      the name a screen reader reads for navigation.
                      The cost is that this figure is visual-only; the
                      ACTIVE discussion's rollup is announced properly
                      in the status line, and title= gives it back on
                      hover. */}
                  {rollupText && (
                    <span
                      aria-hidden="true"
                      title={`Measured run time for this notebook: ${rollupText}`}
                      style={{
                        display: "block",
                        fontSize: "0.75em",
                        color: "#666",
                      }}
                    >
                      {rollupText}
                    </span>
                  )}
                </div>
                <RowMenu
                  label={`Actions for ${data.name}`}
                  items={[
                    {
                      // First: the one constructive action, ahead of
                      // three that act on what already exists. It also
                      // keeps Delete last, furthest from the pointer's
                      // resting place when the menu opens.
                      label: "Add discussion",
                      onSelect: () =>
                        setAddTarget({
                          notebookId: data.notebookId,
                          notebookName: data.name,
                        }),
                    },
                    {
                      label: "Rename",
                      onSelect: () =>
                        setRenameTarget({
                          kind: "notebook",
                          id: data.notebookId,
                          name: data.name,
                        }),
                    },
                    {
                      label: "Export",
                      onSelect: () =>
                        handleExportNotebook(data.notebookId, data.name),
                    },
                    {
                      label: "Delete notebook",
                      destructive: true,
                      onSelect: () =>
                        handleDeleteNotebook(data.notebookId, data.name),
                    },
                  ]}
                />
              </div>
            );
          }

          // data.kind === "discussion"
          const isActive = data.discussionId === activeDiscussionId;
          const isExecuting = data.discussionId === executingDiscussionId;
          return (
            <div
              key={item.getId()}
              {...item.getProps()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: `2px 8px 2px ${paddingLeft}px`,
                cursor: "pointer",
                fontWeight: isActive ? "bold" : "normal",
              }}
            >
              <span aria-hidden="true">💬</span>
              <span style={{ flex: 1 }}>{data.name}</span>
              {isExecuting && (
                <span
                  aria-label="Currently running"
                  style={{
                    fontSize: "0.75em",
                    fontWeight: "bold",
                    color: "#fff",
                    background: "#d97706",
                    borderRadius: 3,
                    padding: "1px 6px",
                  }}
                >
                  ● Running
                </span>
              )}
              <RowMenu
                label={`Actions for ${data.name}`}
                items={[
                  {
                    label: "Rename",
                    onSelect: () =>
                      setRenameTarget({
                        kind: "discussion",
                        id: data.discussionId,
                        name: data.name,
                      }),
                  },
                  {
                    // Task 65. Same position as Export in the notebook
                    // menu above -- between Rename and Delete -- so the
                    // two menus read the same way. This one emits
                    // markdown, not .pact.
                    label: "Export",
                    onSelect: () =>
                      handleExportDiscussion(data.discussionId, data.name),
                  },
                  {
                    label: "Delete discussion",
                    destructive: true,
                    onSelect: () =>
                      handleDeleteDiscussion(data.discussionId, data.name),
                  },
                ]}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
