import type { SupabaseClient } from "@supabase/supabase-js";

// Bootstrap step only — not the real notebook-creation feature (still
// deferred). Gives /api/execute a valid discussionId to target: reuses the
// user's first discussion if one exists, otherwise creates exactly one
// notebook + discussion pair.
export async function ensureDiscussion(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("discussions")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing) {
    return existing.id as string;
  }

  const { data: notebook, error: notebookError } = await supabase
    .from("notebooks")
    .insert({ user_id: userId, name: "My Notebook" })
    .select("id")
    .single();

  if (notebookError || !notebook) {
    throw notebookError ?? new Error("failed to create notebook");
  }

  const { data: discussion, error: discussionError } = await supabase
    .from("discussions")
    .insert({
      notebook_id: notebook.id,
      user_id: userId,
      name: "Discussion",
    })
    .select("id")
    .single();

  if (discussionError || !discussion) {
    throw discussionError ?? new Error("failed to create discussion");
  }

  return discussion.id as string;
}
