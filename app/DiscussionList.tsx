"use client";

import { useEffect, useState } from "react";

interface Discussion {
  id: string;
  name: string | null;
}

export function DiscussionList({
  activeDiscussionId,
  onSelect,
  refetchToken,
}: {
  activeDiscussionId: string;
  onSelect: (discussionId: string) => void;
  refetchToken: number;
}) {
  const [discussions, setDiscussions] = useState<Discussion[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/discussions")
      .then((response) => response.json())
      .then((body) => {
        if (!cancelled) setDiscussions(body);
      });

    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  return (
    <section>
      <h2>Discussions</h2>
      <ul>
        {discussions.map((discussion) => (
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
    </section>
  );
}
