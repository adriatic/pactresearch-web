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
const PAGE_SIZE = 100;

export async function removePromptImagesForDiscussion(
  supabase: SupabaseClient,
  userId: string,
  discussionId: string,
): Promise<void> {
  const prefix = `${userId}/${discussionId}`;
  // Task 89. list() returns at most one page (100 by default), so a single
  // list-and-remove left everything past the first 100 behind. Remove a
  // page at a time until the prefix is empty. Always from offset 0: what
  // was removed is no longer listed, so the next page is the next batch.
  for (;;) {
    const { data: files, error: listError } = await supabase.storage
      .from("prompt-images")
      .list(prefix, { limit: PAGE_SIZE, offset: 0 });

    if (listError) {
      throw listError;
    }
    if (!files || files.length === 0) {
      return;
    }

    const paths = files.map((file) => `${prefix}/${file.name}`);
    const { data: removed, error: removeError } = await supabase.storage
      .from("prompt-images")
      .remove(paths);

    if (removeError) {
      throw removeError;
    }
    // Listed but nothing removed (say, a delete rule that refuses them):
    // listing again would return the same page forever. Fail instead, so
    // the caller keeps the discussion row and the user can retry.
    if (!removed || removed.length === 0) {
      throw new Error(
        `Could not remove prompt images under ${prefix}: none of ${paths.length} were removed.`,
      );
    }
  }
}
