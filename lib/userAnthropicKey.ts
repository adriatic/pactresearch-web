import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "@/lib/apiKeyCrypto";

// Task 51. Fetches and decrypts the calling user's own Anthropic key.
//
// Server-only: it decrypts, so it must never be reachable from a client
// component. Returns null when the user has not stored one, which
// callers turn into the blocking message rather than an Anthropic error.

// The single message shown when a run is blocked for want of a key.
// Shared so /api/execute and /api/refine-system-prompt cannot drift into
// telling the user two different things about the same problem.
export const MISSING_KEY_MESSAGE =
  "Add your Anthropic API key in Account → Keys before running prompts.";

// A machine-readable marker so the UI can treat this as a setup step
// rather than a failure, without matching on message text.
export const MISSING_KEY_CODE = "missing_anthropic_key";

export async function getUserAnthropicKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("anthropic_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const stored = data?.anthropic_key_encrypted;
  if (!stored) return null;

  // Deliberately allowed to throw. A row that cannot be decrypted means
  // the secret changed or the data came from elsewhere; failing loudly
  // is right, because the alternative is sending garbage to Anthropic
  // and reporting its 401 as if the user's key were wrong.
  return decryptSecret(stored);
}
