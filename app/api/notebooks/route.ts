import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { removePromptImagesForDiscussion } from "@/lib/promptImagesCleanup";

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

  // Storage cleanup for every discussion in this notebook, before the
  // notebook row delete -- same reasoning as DELETE /api/discussions:
  // fail the whole request (don't delete the row) if any of it errors,
  // so a retry can pick up wherever it left off rather than the
  // discussion_ids needed to find these images becoming unreachable the
  // moment the notebook (and its cascaded discussion rows) is gone.
  const { data: notebookDiscussions, error: discussionsListError } =
    await supabase.from("discussions").select("id").eq("notebook_id", id);

  if (discussionsListError) {
    throw discussionsListError;
  }

  try {
    for (const discussion of notebookDiscussions ?? []) {
      await removePromptImagesForDiscussion(supabase, user.id, discussion.id);
    }
  } catch (cleanupError) {
    console.error(
      "Failed to clean up prompt images before notebook delete:",
      cleanupError,
    );
    return Response.json(
      { error: "Failed to remove this notebook's images. Try again." },
      { status: 500 },
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

async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional narrowing to a single notebook -- same "still a list response
  // shape, just filtered server-side" pattern GET /api/discussions already
  // uses for its own ?id= param. Added for SettingsDialog.tsx, which needs
  // one notebook's current system_prompt fresh at open time, not the
  // user's whole notebook list.
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  // Session-scoped client + RLS: this already returns only the caller's
  // own notebooks, same reliance on RLS as GET /api/discussions — no
  // separate user_id filter needed here either.
  let query = supabase
    .from("notebooks")
    .select("*")
    .order("created_at", { ascending: false });

  if (id) {
    query = query.eq("id", id);
  }

  const { data: notebooks, error } = await query;

  if (error) {
    throw error;
  }

  return Response.json(notebooks);
}

interface UpdateNotebookRequestBody {
  systemPrompt: string | null;
}

async function handlePatch(request: Request) {
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

  let systemPrompt: string | null;
  try {
    const body = (await request.json()) as UpdateNotebookRequestBody;
    systemPrompt = body.systemPrompt;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (systemPrompt !== null && typeof systemPrompt !== "string") {
    return Response.json(
      { error: "systemPrompt must be a string or null." },
      { status: 400 },
    );
  }

  // Session-scoped client + RLS: this can only ever update a notebook the
  // caller owns — an empty result covers both "doesn't exist" and "isn't
  // yours", same non-distinguishing 404 pattern as PATCH /api/discussions.
  // Whitespace-only input is normalized to null here (the single place
  // this is ever written), not left for every reader (SettingsDialog on
  // reopen, /api/execute on run) to separately re-derive "empty" from —
  // matching draft_content's own isEmptyDoc-at-write-time normalization.
  const trimmed = systemPrompt?.trim();
  const { data: updated, error } = await supabase
    .from("notebooks")
    .update({ system_prompt: trimmed ? trimmed : null })
    .eq("id", id)
    .select();

  if (error) {
    throw error;
  }

  if (updated.length === 0) {
    return Response.json({ error: "Notebook not found." }, { status: 404 });
  }

  return Response.json(updated[0]);
}

export const POST = withRouteErrorHandling(handlePost);
export const DELETE = withRouteErrorHandling(handleDelete);
export const GET = withRouteErrorHandling(handleGet);
export const PATCH = withRouteErrorHandling(handlePatch);
