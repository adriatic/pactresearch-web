import type { ActivityRollup } from "@/lib/activityRollup";

// Task 55c. Turning a rollup into something a person can read.
//
// Pure and separate from the data layer on purpose: this is the half
// with the judgement calls in it, and judgement calls deserve unit
// tests that do not need a database to run.

// Rounded to whole seconds above a second: this is a "how long did the
// work take" figure, and millisecond precision on a two-minute total is
// noise pretending to be accuracy. Below a second, the milliseconds are
// the only thing there is to say.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// The rule the task exists to get right: a measured zero and an
// unmeasured one look identical and mean opposite things.
//
// execution_timings only began on 2026-09-21, so anything older ran
// without ever being timed. getNotebookRollup/getDiscussionRollup
// already detect that and set hasUnmeasuredActivity; this is where it
// has to actually change what the user reads. "0s" for a notebook that
// ran for an hour last month is not an approximation, it is wrong.
export function formatRollupTotal(rollup: ActivityRollup | null): string {
  if (!rollup) return "";

  const { totalTimeMs, runCount, hasUnmeasuredActivity } = rollup;

  if (hasUnmeasuredActivity) {
    // Some of the work predates timing. If part of it WAS measured, say
    // the measured part and mark it approximate -- hiding a real number
    // is as unhelpful as presenting a partial one as complete.
    return totalTimeMs > 0
      ? `~${formatDuration(totalTimeMs)} (partly measured)`
      : "Not measured";
  }

  // Fully within the measured era and genuinely nothing has run. Not
  // "0s", which reads as "ran instantly".
  if (runCount === 0 && totalTimeMs === 0) return "No runs yet";

  // Runs happened but contributed no time -- every one of them failed
  // before a duration could be recorded. Rare, and "0s" would be a lie
  // about it.
  if (totalTimeMs === 0) return "Not measured";

  return formatDuration(totalTimeMs);
}

// Short, local, and unambiguous about the day. Deliberately not a
// relative "3 days ago": the status line sits next to a duration, and
// mixing an absolute duration with a relative timestamp invites reading
// one as the other.
export function formatActivityTimestamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The full status-line string: what Nik originally asked for is a
// timestamp AND a total, so both, joined only when both exist.
export function formatActivitySummary(rollup: ActivityRollup | null): string {
  if (!rollup) return "";
  const total = formatRollupTotal(rollup);
  const when = formatActivityTimestamp(rollup.lastActivity);
  if (total && when) return `Last activity ${when} · ${total}`;
  return total || (when ? `Last activity ${when}` : "");
}
