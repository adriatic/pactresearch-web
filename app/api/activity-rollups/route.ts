import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import {
  getDiscussionRollup,
  getNotebookRollup,
  type ActivityRollup,
} from "@/lib/activityRollup";

// Task 55c. Read-only access to the rollups tasks 55a/55b computed.
//
// Two shapes, because the two display surfaces need different things:
//
//   GET /api/activity-rollups                  -> every notebook's rollup
//   GET /api/activity-rollups?discussionId=ID  -> one discussion's
//
// Derived on read every time, never cached or stored. That is the whole
// point of activityRollup.ts's design -- notebooks.updated_at is the
// cautionary example of a materialised value nothing keeps honest, and
// adding a cache here would reintroduce it one layer up.
//
// COST, stated plainly. Each rollup is a handful of index-friendly
// queries (container, discussions, then min/max/count over responses
// and execution_timings), so the bulk shape is O(notebooks) round trips
// inside the same region. For this app's scale -- a researcher with a
// handful of notebooks -- that is the right trade against the
// alternative, which is a GROUP BY that PostgREST cannot express and so
// would need a SQL function, i.e. a migration, for a display-only
// feature. If notebook counts ever reach the point where this is slow,
// that RPC is the fix, and this comment is the note explaining why it
// was not done first.
async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const discussionId = new URL(request.url).searchParams.get("discussionId");

  if (discussionId) {
    // RLS scopes this to the caller's own discussion; a missing or
    // someone else's id is indistinguishable here and yields null,
    // matching the non-distinguishing 404 pattern the other routes use.
    const discussion = await getDiscussionRollup(supabase, discussionId);
    return Response.json({ discussion });
  }

  const { data: notebooks, error } = await supabase
    .from("notebooks")
    .select("id");
  if (error) throw error;

  const entries = await Promise.all(
    (notebooks ?? []).map(
      async (n): Promise<[string, ActivityRollup | null]> => [
        n.id,
        await getNotebookRollup(supabase, n.id),
      ],
    ),
  );

  return Response.json({
    notebooks: Object.fromEntries(
      entries.filter((entry): entry is [string, ActivityRollup] =>
        Boolean(entry[1]),
      ),
    ),
  });
}

export const GET = withRouteErrorHandling(handleGet);
