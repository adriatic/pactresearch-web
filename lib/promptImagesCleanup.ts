import type { SupabaseClient } from "@supabase/supabase-js";

// Postgres's own ON DELETE CASCADE never reaches Supabase Storage --
// storage.objects isn't foreign-keyed to discussions/responses in any way
// the database itself understands, so deleting a discussion or notebook
// would otherwise leave every image it ever held as a permanent,
// invisible-to-the-app orphan. This is the shared cleanup both
// DELETE /api/discussions and DELETE /api/notebooks call, before their
// own row delete -- see the design doc's own reasoning for that ordering:
// if this throws, the caller must not delete the row, so a retry (the
// user simply clicking delete again) naturally re-lists the same prefix
// and finishes whatever's left, rather than the discussion_id/prefix
// becoming unreachable the moment the row is gone.
export async function removePromptImagesForDiscussion(
  supabase: SupabaseClient,
  userId: string,
  discussionId: string,
): Promise<void> {
  const prefix = `${userId}/${discussionId}`;
  const { data: files, error: listError } = await supabase.storage
    .from("prompt-images")
    .list(prefix);

  if (listError) {
    throw listError;
  }
  if (!files || files.length === 0) {
    return;
  }

  const paths = files.map((file) => `${prefix}/${file.name}`);
  const { error: removeError } = await supabase.storage
    .from("prompt-images")
    .remove(paths);

  if (removeError) {
    throw removeError;
  }
}
