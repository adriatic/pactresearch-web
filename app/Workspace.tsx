"use client";

import { useState } from "react";
import { ExecuteTester } from "./ExecuteTester";
import { NotebookCreator } from "./NotebookCreator";
import { DiscussionList } from "./DiscussionList";

export function Workspace({
  initialDiscussionId,
}: {
  initialDiscussionId: string | null;
}) {
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    initialDiscussionId,
  );
  // Bumped whenever a discussion is created or a notebook is deleted, so
  // DiscussionList's effect refetches — it doesn't otherwise depend on
  // anything that changes here.
  const [discussionListRefetchToken, setDiscussionListRefetchToken] =
    useState(0);

  function handleDiscussionCreated(discussionId: string) {
    setActiveDiscussionId(discussionId);
    setDiscussionListRefetchToken((t) => t + 1);
  }

  function handleNotebookDeleted(deletedDiscussionIds: string[]) {
    if (
      activeDiscussionId &&
      deletedDiscussionIds.includes(activeDiscussionId)
    ) {
      setActiveDiscussionId(null);
    }
    setDiscussionListRefetchToken((t) => t + 1);
  }

  return (
    <>
      <ExecuteTester discussionId={activeDiscussionId} />
      <hr />
      <DiscussionList
        activeDiscussionId={activeDiscussionId}
        onSelect={setActiveDiscussionId}
        onNotebookDeleted={handleNotebookDeleted}
        refetchToken={discussionListRefetchToken}
      />
      <hr />
      <NotebookCreator onDiscussionCreated={handleDiscussionCreated} />
    </>
  );
}
