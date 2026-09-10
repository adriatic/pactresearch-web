import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { timed, withFullTiming, type HandlerTimer } from "@/lib/timing";

async function handleGet(timer: HandlerTimer, request: Request) {
  const supabase = await createClient();
  const authStart = performance.now();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  timer.mark("auth", performance.now() - authStart);

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const discussionId = searchParams.get("discussionId");

  if (!discussionId) {
    return Response.json(
      { error: "discussionId is required." },
      { status: 400 },
    );
  }
  timer.setLabel(`GET /api/responses discussionId=${discussionId}`);

  // Session-scoped client: RLS ("Users manage their own discussions")
  // restricts this to discussions the caller owns, so a discussionId
  // belonging to another user is indistinguishable here from one that
  // doesn't exist at all — both are just "not found" from this caller's
  // perspective. Same pattern as POST /api/discussions' notebook check.
  const existenceCheckStart = performance.now();
  const { data: discussion, error: discussionError } = await supabase
    .from("discussions")
    .select("id")
    .eq("id", discussionId)
    .maybeSingle();
  timer.mark("existence-check", performance.now() - existenceCheckStart);

  if (discussionError) {
    throw discussionError;
  }

  if (!discussion) {
    return Response.json({ error: "Discussion not found." }, { status: 404 });
  }

  const { data: responses, error } = await timed(
    `GET /api/responses discussionId=${discussionId}`,
    () =>
      supabase
        .from("responses")
        .select("*")
        .eq("discussion_id", discussionId)
        .order("created_at", { ascending: true }),
  );

  if (error) {
    throw error;
  }

  return Response.json(responses);
}

export const GET = withRouteErrorHandling(
  withFullTiming("GET /api/responses", handleGet),
);
