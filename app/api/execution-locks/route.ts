import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

// Explorer polls this to show which discussion (if any) the caller
// currently has running, so a discussion left executing after switching
// away from it doesn't look identical to an idle one in the tree.
//
// Reuses the exact signal that already blocks deletion of an executing
// discussion/notebook (DELETE /api/discussions, DELETE /api/notebooks --
// both via execution_locks and the discussion_has_active_execution_lock /
// notebook_active_execution_lock_discussion_id RPCs, see 20260908224401
// and 20260921014348) rather than inventing a new detection mechanism.
// execution_locks is keyed by user_id (one lock per user, not per
// discussion), so RLS ("Users manage their own execution lock") already
// restricts this select to at most the caller's own single row -- no
// separate ownership check needed, same as every other route here.
//
// The 5-minute staleness cutoff mirrors execution_lock_stale_after()
// (20260908224401) as a plain literal rather than calling it via RPC --
// it's the single source of truth those RPCs already share, and
// duplicating the constant here avoids a second round trip for one
// value. If that function's threshold ever changes, this must change
// with it.
const STALE_AFTER_MS = 5 * 60 * 1000;

async function handleGet() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: lock, error } = await supabase
    .from("execution_locks")
    .select("discussion_id, acquired_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  const isStale =
    !lock || Date.now() - new Date(lock.acquired_at).getTime() > STALE_AFTER_MS;

  return Response.json({ discussionId: isStale ? null : lock.discussion_id });
}

export const GET = withRouteErrorHandling(handleGet);
