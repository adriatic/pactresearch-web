import type { SupabaseClient } from "@supabase/supabase-js";

// Plain lookup — the caller's most recently created discussion, or null if
// they have none. Same recency ordering as DiscussionList. This used to
// also create a notebook + discussion when none existed (as ensureDiscussion),
// but real creation (NotebookCreator) and a working "no discussion selected"
// empty state (ExecuteTester) both exist now, so silently resurrecting a
// generic discussion is no longer justified — a caller with zero discussions
// just gets null.
export async function findLatestDiscussion(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: latest, error } = await supabase
    .from("discussions")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return latest ? (latest.id as string) : null;
}
