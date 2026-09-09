"use client";

import { useState } from "react";
import { NotebookCreator } from "./NotebookCreator";
import { Explorer } from "./Explorer";
import { Composer } from "./Composer";
import { DiscussionContent } from "./DiscussionContent";
import { useDiscussionExecution } from "./useDiscussionExecution";

// Fixed-layout shell — opens the structural half of Phase D's port,
// alongside Explorer's tree view: a left sidebar (Explorer, its own
// independent scroll), a fixed header toolbar, a fixed composer, and a
// scrolling middle region for the active discussion's content. Ports
// pact-mac's actual App.tsx shell structure (confirmed against a
// screenshot of the real app): the composer sits fixed near the top of
// the main panel, directly below the header, above the scrolling
// content — not a bottom-pinned footer. Header toolbar buttons
// (New Notebook/Import/Settings/Account/Model) exist in their real fixed
// position but stay disabled/unwired, per this task's explicit scope —
// their dialogs/behavior are separate, not-yet-built work.
export function Workspace({
  initialDiscussionId,
}: {
  initialDiscussionId: string | null;
}) {
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    initialDiscussionId,
  );
  // Bumped whenever a discussion is created or a notebook is deleted, so
  // Explorer's effect refetches — it doesn't otherwise depend on anything
  // that changes here.
  const [discussionListRefetchToken, setDiscussionListRefetchToken] =
    useState(0);
  // Rebroadcast down to NotebookCreator, the same shape as
  // discussionListRefetchToken above — set here from Explorer's callback,
  // consumed by whichever child needs to react.
  const [lastDeletedNotebookId, setLastDeletedNotebookId] = useState<
    string | null
  >(null);

  const execution = useDiscussionExecution(activeDiscussionId);

  function handleDiscussionCreated(discussionId: string) {
    setActiveDiscussionId(discussionId);
    setDiscussionListRefetchToken((t) => t + 1);
  }

  function handleNotebookDeleted(
    notebookId: string,
    deletedDiscussionIds: string[],
  ) {
    if (
      activeDiscussionId &&
      deletedDiscussionIds.includes(activeDiscussionId)
    ) {
      setActiveDiscussionId(null);
    }
    setDiscussionListRefetchToken((t) => t + 1);
    setLastDeletedNotebookId(notebookId);
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <div style={{ width: 280, flexShrink: 0, overflowY: "auto" }}>
        <Explorer
          activeDiscussionId={activeDiscussionId}
          onSelect={setActiveDiscussionId}
          onNotebookDeleted={handleNotebookDeleted}
          refetchToken={discussionListRefetchToken}
        />
        <hr />
        <NotebookCreator
          onDiscussionCreated={handleDiscussionCreated}
          lastDeletedNotebookId={lastDeletedNotebookId}
        />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header style={{ flexShrink: 0 }}>
          <strong>PACT</strong>{" "}
          <button type="button" disabled>
            New Notebook
          </button>{" "}
          <button type="button" disabled>
            Import
          </button>{" "}
          <button type="button" disabled>
            Settings
          </button>{" "}
          <button type="button" disabled>
            Account
          </button>{" "}
          <button type="button" disabled>
            Model
          </button>
        </header>
        <div style={{ flexShrink: 0 }}>
          <Composer
            discussionId={activeDiscussionId}
            promptText={execution.promptText}
            setPromptText={execution.setPromptText}
            loading={execution.loading}
            onSubmit={execution.handleSubmit}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <DiscussionContent
            discussionId={activeDiscussionId}
            history={execution.history}
            streamedResponse={execution.streamedResponse}
            streamedModel={execution.streamedModel}
            isStreaming={execution.isStreaming}
            result={execution.result}
          />
        </div>
      </div>
    </div>
  );
}
