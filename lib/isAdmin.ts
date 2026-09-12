import type { SupabaseClient } from "@supabase/supabase-js";

// Reusable admin check for route handlers. Takes the caller's own
// session-scoped client (from utils/supabase/server.ts) -- the same
// client already used for auth.getUser() -- so RLS's `user_id =
// auth.uid()` policy on user_roles is what actually enforces "only your
// own row", not this function. A missing row, an explicit `is_admin =
// false`, and a NULL is_admin value are all treated identically as
// "not admin" -- see the migration's is_admin default-false-but-nullable
// note for why NULL is a possible value here at all.
export async function isAdmin(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("is_admin")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.is_admin === true;
}
