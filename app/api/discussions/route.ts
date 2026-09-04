import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

interface CreateDiscussionRequestBody {
  notebookId: string;
  name: string;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let notebookId: string;
  let name: string;
  try {
    const body = (await request.json()) as CreateDiscussionRequestBody;
    notebookId = body.notebookId;
    name = body.name;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (typeof notebookId !== "string" || notebookId.trim().length === 0) {
    return Response.json(
      { error: "notebookId is required and must be a non-empty string." },
      { status: 400 },
    );
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json(
      { error: "name is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  // Session-scoped client: RLS ("Users manage their own notebooks")
  // restricts this to notebooks the caller owns, so a notebookId belonging
  // to another user is indistinguishable here from one that doesn't exist
  // at all — both are just "not found" from this caller's perspective.
  const { data: notebook, error: notebookError } = await supabase
    .from("notebooks")
    .select("id")
    .eq("id", notebookId)
    .maybeSingle();

  if (notebookError) {
    throw notebookError;
  }

  if (!notebook) {
    return Response.json({ error: "Notebook not found." }, { status: 404 });
  }

  const { data: discussion, error: insertError } = await supabase
    .from("discussions")
    .insert({ notebook_id: notebookId, user_id: user.id, name })
    .select()
    .single();

  if (insertError) {
    throw insertError;
  }

  return Response.json(discussion, { status: 201 });
}

export const POST = withRouteErrorHandling(handlePost);
