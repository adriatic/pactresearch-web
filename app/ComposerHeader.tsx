"use client";

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

  const statusColor = isRunning ? RUNNING_COLOR : IDLE_COLOR;

  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "4px 8px",
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
        {discussionId
          ? (discussionName ?? "Loading...")
          : "No discussion selected"}
      </span>
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
    </div>
  );
}
