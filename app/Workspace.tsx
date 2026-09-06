"use client";

import { useState } from "react";
import { ExecuteTester } from "./ExecuteTester";
import { NotebookCreator } from "./NotebookCreator";

export function Workspace({
  initialDiscussionId,
}: {
  initialDiscussionId: string;
}) {
  const [activeDiscussionId, setActiveDiscussionId] =
    useState(initialDiscussionId);

  return (
    <>
      <ExecuteTester discussionId={activeDiscussionId} />
      <hr />
      <NotebookCreator onDiscussionCreated={setActiveDiscussionId} />
    </>
  );
}
