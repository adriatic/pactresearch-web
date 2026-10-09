"use client";

import { useEffect, useState } from "react";
import type { RichContent } from "@/lib/richContent";
import type { ContextChoice } from "@/lib/historyPlan";
import type { PlanSummary } from "./contextSummary";

// Task 71 Stage 2. Asks the server what the next question would send
// (/api/history-plan, the same plan the run uses). Re-asked when the
// discussion, its turns, the choice or the prompt changes -- the prompt
// after a short pause, so typing does not send a request per keystroke.
export function useHistoryPlan(
  discussionId: string | null,
  content: RichContent,
  choice: ContextChoice | undefined,
  historyKey: number,
  enabled = true,
): PlanSummary | null {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const choiceKey = JSON.stringify(choice ?? null);

  useEffect(() => {
    if (!discussionId || !enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/history-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          discussionId,
          promptContent: content,
          context: choice,
        }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: PlanSummary | null) => setPlan(body))
        .catch(() => {
          // A failed or superseded hint is not worth an error message;
          // the run itself is unaffected.
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // choiceKey stands in for choice; content is compared by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discussionId, content, choiceKey, historyKey, enabled]);

  return discussionId && enabled ? plan : null;
}
