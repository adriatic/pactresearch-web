"use client";

import type { ActivityRollup } from "@/lib/activityRollup";
import { formatActivitySummary } from "@/lib/formatActivity";
import { downloadDiscussionExport } from "@/lib/downloadDiscussionExport";

import { useEffect, useState } from "react";

// The discussion-name/status row that sits directly above the composer,
// porting pact-mac's own equivalent (task 37): the active discussion's
// name on the left, a live run-status indicator on the right (elapsed
// time + a status dot).
//
// The elapsed time is a purely CLIENT-SIDE timer, deliberately, and not
// read from any stored column. discussions.total_time_ms exists in the
// schema (20260825032825) but nothing in pact-web ever computes or
// writes it -- its only readers/writers are the .pact export/import
// round trip (app/api/notebooks/export/route.ts and .../import/route.ts),
// so for any discussion created in pact-web it is permanently 0. Binding
// this display to it would render a hardcoded "0s" forever. The other
// candidate, execution_timings (20260920184603), is explicitly not
// applied and not written to yet -- see that migration's own header.
// A live ticking display during a run also can't come from a stored
// per-run total either way, since that value only exists once the run
// has already finished.
//
// Colors mirror pact-mac's own actual implementation (App.tsx's status
// indicator), which is green when IDLE and red while RUNNING -- a
// traffic-light reading ("green: free to start", "red: busy"), not the
// "green means active" convention. Kept faithful to the reference on
// purpose; see this task's status report, which flags the discrepancy
// with the task brief's own description of it.
const RUNNING_COLOR = "#e05252";
const IDLE_COLOR = "#4ec94e";

// Ticks well under a second so the displayed whole-second value flips
// close to its real boundary rather than lagging by up to a full second,
// which reads as a stuttering timer.
const TICK_MS = 250;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

export function ComposerHeader({
  discussionId,
  discussionName,
  isRunning,
}: {
  discussionId: string | null;
  discussionName: string | null;
  // The active discussion's own run state -- useDiscussionExecution's
  // `loading`, the same value that already gates the header's Run button,
  // so this needs no new execution-state tracking of its own. Covers a
  // retry identically, since run() and retry() share the hook's own
  // submit path.
  isRunning: boolean;
}) {
  // Task 65 follow-up: state for this header's own Export button,
  // declared here because the render-time reset below clears it.
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Task 55c. The active discussion's rollup, re-fetched on every
  // switch AND whenever a run finishes -- a total that only updated on
  // page load would be wrong the moment the user did the one thing
  // that changes it.
  const [rollup, setRollup] = useState<ActivityRollup | null>(null);
  // Cleared during render, keyed on the discussion it belongs to,
  // rather than in the effect below. Two reasons, and the lint rule
  // that rejects the alternative (react-hooks/set-state-in-effect) is
  // the lesser one: clearing in an effect means the first paint after a
  // switch still shows the PREVIOUS discussion's total next to the new
  // discussion's name -- briefly attributing one discussion's time to
  // another. Same render-time reset idiom AccountDialog,
  // SettingsDialog, ModelTierDialog and NewNotebookDialog all use.
  const [rollupOwner, setRollupOwner] = useState<string | null>(null);
  if (rollupOwner !== discussionId) {
    setRollupOwner(discussionId);
    setRollup(null);
    // A failure message belongs to the discussion it was about. Cleared
    // here rather than in an effect for the same reason the rollup is
    // (react-hooks/set-state-in-effect, and the stale first paint).
    setExportError(null);
  }
  useEffect(() => {
    if (!discussionId) return;
    let cancelled = false;
    // Keyed on isRunning as well as the id: when a run ends this flips
    // false and the effect re-runs, picking up the total_time_ms the
    // run just added. Display-only, so a failure clears rather than
    // surfaces -- a broken rollup must not break the header.
    fetch(`/api/activity-rollups?discussionId=${discussionId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { discussion?: ActivityRollup | null } | null) => {
        if (!cancelled) setRollup(body?.discussion ?? null);
      })
      .catch(() => {
        if (!cancelled) setRollup(null);
      });
    return () => {
      cancelled = true;
    };
  }, [discussionId, isRunning]);
  const activitySummary = formatActivitySummary(rollup);
  // Milliseconds elapsed in the run this component last observed. Only
  // ever written from the interval callback below and from that effect's
  // own cleanup -- never synchronously during render or in an effect
  // body, both of which this repo's lint config rejects outright
  // (react-hooks/purity for a render-time Date.now(),
  // react-hooks/set-state-in-effect for a synchronous setState in an
  // effect body).
  const [elapsedMs, setElapsedMs] = useState(0);
  // Distinguishes "never run in this session" (show nothing) from
  // "finished, here's how long it took" (show the frozen final value).
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    if (!isRunning) return;
    // Captured here, not in render: Date.now() is impure, so it can only
    // be read from an effect/callback, never while rendering.
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
      setHasRun(true);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      // Freeze on the exact final duration rather than whatever the last
      // tick happened to catch, so a finished run reports its real time
      // instead of one rounded down to the previous tick.
      setElapsedMs(Date.now() - startedAt);
      setHasRun(true);
    };
  }, [isRunning]);

  // A different discussion is a different timer -- the previous
  // discussion's elapsed value says nothing about this one. Reset lives
  // in its own effect keyed on discussionId; the setState calls are in
  // the cleanup rather than the body for the same lint reason as above.
  useEffect(() => {
    return () => {
      setElapsedMs(0);
      setHasRun(false);
    };
  }, [discussionId]);

  // Task 65 follow-up. Export the discussion you are looking at, from
  // where you are looking at it. The Explorer's row menu already offers
  // this, but reaching it means finding the row for the discussion
  // already open in front of you -- and in a tree of any size that is
  // the long way round.
  //
  // Same endpoint, same shared download helper as the row menu, so the
  // two cannot produce different files.
  async function handleExport() {
    if (!discussionId) return;
    setExportError(null);
    setExporting(true);
    const ok = await downloadDiscussionExport(discussionId);
    setExporting(false);
    if (!ok) setExportError("Export failed");
  }

  const statusColor = isRunning ? RUNNING_COLOR : IDLE_COLOR;

  return (
    // role/aria-label give this row a stable accessible name, which is
    // also how discussion-header-name.spec.ts targets it. Deliberately
    // not a second <header> element: Workspace already has one for the
    // toolbar, and several specs locate that with a bare
    // page.locator("header"), which a second one would break under
    // Playwright's strict mode. Deliberately not a data-testid either --
    // this repo has no such convention (zero occurrences in app/ or
    // e2e/), and an accessible name is the better hook regardless.
    <div
      role="group"
      aria-label="Active discussion"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        // 12px horizontal, not the original 8px: task 44 item B gave the
        // composer directly below and the response panel a 12px inset,
        // and this row sits immediately above the composer -- leaving it
        // at 8px would have put the discussion name a few pixels left of
        // the prompt text it labels.
        padding: "4px 12px",
        fontSize: "0.9em",
      }}
    >
      <span
        style={{
          fontWeight: "bold",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {/* "Loading..." rather than falling back to the raw discussionId
            -- persistence audit finding E, whose rationale moved here
            with the name itself (task 38) when DiscussionContent's own
            duplicate "Discussion: ..." line was removed: nothing requires
            a uuid to appear on screen as identifying text, even
            transiently while the name resolves. */}
        {discussionId
          ? (discussionName ?? "Loading...")
          : "No discussion selected"}
      </span>
      {/* Task 55c. Timestamp AND total, which is what was originally
          asked for -- "Last activity 28 Sep 14:32 · 2m 14s", or
          "No runs yet" / "Not measured" when there is nothing real to
          report.

          A plain span, deliberately NOT role="status". There is already
          exactly one status node in this app (the running indicator
          just below), and report-a-problem.spec.ts targets it with an
          unqualified getByRole("status") -- a second one is a
          strict-mode violation, which DiscussionContent.tsx already
          carries a comment about avoiding. This text also changes only
          on a switch or a completed run, so it needs no live region to
          be noticed. */}
      {discussionId && activitySummary && (
        <span
          style={{
            color: "#666",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activitySummary}
        </span>
      )}
      {discussionId && (
        <span
          // One live region for the pair, so a screen reader announces
          // "Running, 12s elapsed" as a single status rather than reading
          // a decorative dot and a bare number separately.
          role="status"
          aria-label={
            isRunning
              ? `Running, ${formatElapsed(elapsedMs)} elapsed`
              : hasRun
                ? `Idle, last run took ${formatElapsed(elapsedMs)}`
                : "Idle"
          }
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span
            aria-hidden="true"
            style={{
              fontFamily: "monospace",
              fontSize: "0.85em",
              color: statusColor,
              minWidth: "4ch",
              textAlign: "right",
            }}
          >
            {isRunning || hasRun ? formatElapsed(elapsedMs) : ""}
          </span>
          <span
            aria-hidden="true"
            title={isRunning ? "Running" : "Idle"}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: statusColor,
              transition: "background 0.3s",
            }}
          />
        </span>
      )}
      {discussionId && (
        <>
          {exportError && (
            // Next to the button that failed, not in the sidebar where
            // the Explorer puts its own copy -- a message about a click
            // belongs where the click happened.
            <span style={{ color: "#b00", whiteSpace: "nowrap" }}>
              {exportError}
            </span>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            // "Export discussion", not "Export". Playwright matches
            // accessible names by case-insensitive SUBSTRING unless told
            // otherwise, and this app's tree rows are conventionally
            // named "E2E <feature> notebook ...", so a button simply
            // named "Export" collides with the "Actions for E2E
            // discussion-export notebook ..." trigger. The longer name
            // keeps a page-level locator unambiguous on its own, and
            // reads better to a screen reader besides. See the note at
            // the top of e2e/rowMenuActions.ts.
            aria-label="Export discussion"
            title="Export this discussion as a markdown file"
            style={{
              flexShrink: 0,
              fontSize: "0.85em",
              padding: "2px 8px",
              cursor: exporting ? "default" : "pointer",
            }}
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
        </>
      )}
    </div>
  );
}
