import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  // Session-scoped client: RLS ("Users manage their own discussions")
  // restricts this to discussions the caller owns, so a discussionId
  // belonging to another user is indistinguishable here from one that
  // doesn't exist at all — both are just "not found" from this caller's
  // perspective. Same pattern as POST /api/discussions' notebook check.
  const { data: discussion, error: discussionError } = await supabase
    .from("discussions")
    .select("id")
    .eq("id", discussionId)
    .maybeSingle();

  if (discussionError) {
    throw discussionError;
  }

  if (!discussion) {
    return Response.json({ error: "Discussion not found." }, { status: 404 });
  }

  const { data: responses, error } = await supabase
    .from("responses")
    .select("*")
    .eq("discussion_id", discussionId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return Response.json(responses);
}

export const GET = withRouteErrorHandling(handleGet);
