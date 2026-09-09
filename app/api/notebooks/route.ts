import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

// "Samples" was cut from pact-web entirely (see 3.13) — not a valid category
// here even though the old pact-mac dialog offered it.
const VALID_CATEGORIES = ["Personal Research", "Dev Test"] as const;

interface CreateNotebookRequestBody {
  name: string;
  category?: string | null;
  systemPrompt?: string | null;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let name: string;
  let category: string | null | undefined;
  let systemPrompt: string | null | undefined;
  try {
    const body = (await request.json()) as CreateNotebookRequestBody;
    name = body.name;
    category = body.category;
    systemPrompt = body.systemPrompt;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json(
      { error: "name is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  if (
    category != null &&
    !(VALID_CATEGORIES as readonly string[]).includes(category)
  ) {
    return Response.json(
      { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` },
      { status: 400 },
    );
  }

  const { data: notebook, error } = await supabase
    .from("notebooks")
    .insert({
      user_id: user.id,
      name,
      category: category ?? null,
      system_prompt: systemPrompt ?? null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return Response.json(notebook, { status: 201 });
}

async function handleDelete(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }

  // Refuse to delete a notebook while one of its discussions has a
  // genuinely active (non-stale) execution lock — otherwise the in-flight
  // Anthropic call keeps running against a notebook/discussion that no
  // longer exists, and its output is silently discarded once it resolves.
  // Reuses the exact staleness threshold try_acquire_execution_lock uses
  // (execution_lock_stale_after()), not a separately invented one.
  const { data: blockingDiscussionId, error: lockCheckError } =
    await supabase.rpc("notebook_active_execution_lock_discussion_id", {
      p_notebook_id: id,
    });

  if (lockCheckError) {
    throw lockCheckError;
  }

  if (blockingDiscussionId) {
    return Response.json(
      {
        error:
          "Cannot delete this notebook while a discussion is actively executing.",
        discussionId: blockingDiscussionId,
      },
      { status: 409 },
    );
  }

  // Session-scoped client + RLS: this can only ever delete a notebook the
  // caller owns. An empty result covers both "doesn't exist" and "isn't
  // yours" — same non-distinguishing 404 pattern as the rest of this
  // codebase, no separate ownership check first. Child rows (discussions,
  // responses, execution_locks) cascade via their own ON DELETE CASCADE.
  const { data: deleted, error } = await supabase
    .from("notebooks")
    .delete()
    .eq("id", id)
    .select();

  if (error) {
    throw error;
  }

  if (deleted.length === 0) {
    return Response.json({ error: "Notebook not found." }, { status: 404 });
  }

  return Response.json(deleted[0]);
}

async function handleGet() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Session-scoped client + RLS: this already returns only the caller's
  // own notebooks, same reliance on RLS as GET /api/discussions — no
  // separate user_id filter needed here either.
  const { data: notebooks, error } = await supabase
    .from("notebooks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return Response.json(notebooks);
}

export const POST = withRouteErrorHandling(handlePost);
export const DELETE = withRouteErrorHandling(handleDelete);
export const GET = withRouteErrorHandling(handleGet);
