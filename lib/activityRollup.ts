import type { SupabaseClient } from "@supabase/supabase-js";

// Task 55b part 2. Derived activity rollups for a discussion and for a
// notebook.
//
// DERIVED ON READ, never stored. A materialised copy needs something to
// keep it honest, and this codebase already has the cautionary example:
// notebooks.updated_at exists, defaults to now(), is maintained by
// nothing -- no trigger, no write path -- and in production every single
// row still has it equal to created_at. A stored rollup would rot the
// same way the first time a write path forgets it.
//
// discussions.total_time_ms is the deliberate exception: it is written
// on run completion (part 1) because .pact export/import already carries
// it, so it has to be a real stored value to survive a round trip.

export interface ActivityRollup {
  // Sum of total_ms across completed runs. See the coverage note below --
  // this reads 0 for activity that predates execution timing.
  totalTimeMs: number;
  // Rows in execution_timings. NOT the number of visible responses: a
  // row is written for every run past the execution lock, including ones
  // that produced nothing (in production, 24 timing rows against 13
  // responses). Do not label this "responses".
  runCount: number;
  // ISO timestamps. firstActivity falls back to the container's own
  // created_at, so it is never null for a real discussion or notebook;
  // lastActivity is the latest of any response, any run, or creation.
  firstActivity: string | null;
  lastActivity: string | null;
  // True when the span includes time that predates execution timing
  // (first row 2026-09-21), so totalTimeMs understates reality rather
  // than being genuinely zero. Lets a caller say "not measured" instead
  // of "0s", which would read as broken.
  hasUnmeasuredActivity: boolean;
}

// The day execution_timings started being written (588bf6c). Activity
// before this was never measured and never can be.
const TIMING_COVERAGE_START = "2026-09-21T00:00:00Z";

function earliest(...values: (string | null | undefined)[]): string | null {
  const real = values.filter((v): v is string => Boolean(v));
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a < b ? a : b));
}

function latest(...values: (string | null | undefined)[]): string | null {
  const real = values.filter((v): v is string => Boolean(v));
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a > b ? a : b));
}

// Min/max created_at for a table over a set of discussion ids, plus the
// row count. Ordered limit-1 queries rather than pulling every row:
// index-friendly, and constant-size regardless of history.
async function spanFor(
  supabase: SupabaseClient,
  table: "responses" | "execution_timings",
  discussionIds: string[],
): Promise<{ first: string | null; last: string | null; count: number }> {
  if (discussionIds.length === 0) return { first: null, last: null, count: 0 };

  const {
    data: firstRow,
    error: firstError,
    count,
  } = await supabase
    .from(table)
    .select("created_at", { count: "exact" })
    .in("discussion_id", discussionIds)
    .order("created_at", { ascending: true })
    .limit(1);
  if (firstError) throw firstError;

  const { data: lastRow, error: lastError } = await supabase
    .from(table)
    .select("created_at")
    .in("discussion_id", discussionIds)
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastError) throw lastError;

  return {
    first: firstRow?.[0]?.created_at ?? null,
    last: lastRow?.[0]?.created_at ?? null,
    count: count ?? 0,
  };
}

async function rollupFor(
  supabase: SupabaseClient,
  discussionIds: string[],
  createdAt: string,
  totalTimeMs: number,
): Promise<ActivityRollup> {
  const [responses, runs] = await Promise.all([
    spanFor(supabase, "responses", discussionIds),
    spanFor(supabase, "execution_timings", discussionIds),
  ]);

  const firstActivity = earliest(createdAt, responses.first, runs.first);
  const lastActivity = latest(createdAt, responses.last, runs.last);

  // Unmeasured if anything happened before timing existed. Uses the
  // responses span rather than creation alone: a notebook created last
  // year with its only run yesterday is fully measured.
  const hasUnmeasuredActivity = Boolean(
    responses.first && responses.first < TIMING_COVERAGE_START,
  );

  return {
    totalTimeMs,
    runCount: runs.count,
    firstActivity,
    lastActivity,
    hasUnmeasuredActivity,
  };
}

// Notebook total is the sum of its discussions' stored totals -- the
// same numbers the per-discussion view shows, so the two can never
// disagree the way an independently-maintained notebook column would.
//
// Exported as a pure function because task 55d needs the identical sum
// at .pact export time, where the discussion rows are already in hand
// and re-querying them would be wasteful. Two call sites, one
// definition of "how long did this notebook take" -- a second `reduce`
// somewhere else is how the exported number and the displayed number
// start disagreeing.
export function sumDiscussionTotalTimeMs(
  discussions: { total_time_ms: number | null }[],
): number {
  return discussions.reduce((sum, d) => sum + (d.total_time_ms ?? 0), 0);
}

export async function getDiscussionRollup(
  supabase: SupabaseClient,
  discussionId: string,
): Promise<ActivityRollup | null> {
  const { data, error } = await supabase
    .from("discussions")
    .select("id, created_at, total_time_ms")
    .eq("id", discussionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return rollupFor(
    supabase,
    [data.id],
    data.created_at,
    data.total_time_ms ?? 0,
  );
}

export async function getNotebookRollup(
  supabase: SupabaseClient,
  notebookId: string,
): Promise<ActivityRollup | null> {
  const { data: notebook, error: notebookError } = await supabase
    .from("notebooks")
    .select("id, created_at")
    .eq("id", notebookId)
    .maybeSingle();
  if (notebookError) throw notebookError;
  if (!notebook) return null;

  const { data: discussions, error: discussionsError } = await supabase
    .from("discussions")
    .select("id, created_at, total_time_ms")
    .eq("notebook_id", notebookId);
  if (discussionsError) throw discussionsError;

  const rows = discussions ?? [];
  const totalTimeMs = sumDiscussionTotalTimeMs(rows);

  // The notebook's own created_at floors the span, so an empty notebook
  // still reports when it came into existence rather than nothing.
  const createdAt =
    earliest(notebook.created_at, ...rows.map((d) => d.created_at)) ??
    notebook.created_at;

  return rollupFor(
    supabase,
    rows.map((d) => d.id),
    createdAt,
    totalTimeMs,
  );
}
