"use client";

import type { ImportSummary } from "@/lib/pactImport";

// Task 79. What the header shows while files import and afterwards: a
// progress hint, then one short summary readable at a glance. It sits where
// the single import error used to appear (inside the header, below the
// buttons), so nothing else on the page moves.
//
// aria-live rather than role="status": report-a-problem.spec.ts relies on
// there being exactly one role="status" on the page.
export function ImportStatus({
  progress,
  summary,
  onDismiss,
}: {
  progress: { done: number; total: number } | null;
  summary: ImportSummary | null;
  onDismiss: () => void;
}) {
  if (!progress && !summary) return null;
  return (
    <div
      data-import-status
      aria-live="polite"
      style={{ fontSize: "0.85em", marginTop: 4 }}
    >
      {progress ? (
        <span>
          Importing {progress.done} of {progress.total}…
        </span>
      ) : summary ? (
        <>
          <strong
            style={{ color: summary.problems.length ? "#a00" : "inherit" }}
          >
            {summary.headline}
          </strong>{" "}
          <button
            type="button"
            aria-label="Dismiss import summary"
            onClick={onDismiss}
            style={{ padding: "0 6px" }}
          >
            ×
          </button>
          {summary.problems.length > 0 && (
            <ul style={{ margin: "2px 0 0", paddingLeft: "1.2em" }}>
              {summary.problems.map((p, i) => (
                <li key={`${p.file}-${i}`}>
                  <strong>{p.file}</strong>: {p.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
