import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret,
  EncryptionNotConfiguredError,
} from "@/lib/apiKeyCrypto";

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

// A stored key that exists but cannot be decrypted -- the row was
// written under a different API_KEY_ENCRYPTION_SECRET (rotated, or an
// environment pointed at another deployment's data). Actionable by the
// user: re-saving re-encrypts under the current secret.
export const UNREADABLE_KEY_MESSAGE =
  "Your saved Anthropic API key could not be read. Open Account → Keys " +
  "and save it again.";
export const UNREADABLE_KEY_CODE = "unreadable_anthropic_key";

// The server has no usable API_KEY_ENCRYPTION_SECRET at all. Nothing the
// user can do about it, so say that plainly instead of implying their
// key is wrong -- and say that nothing was sent to Anthropic, because
// the obvious worry on a failed run is whether it was charged for.
export const KEY_ENCRYPTION_UNCONFIGURED_MESSAGE =
  "This server is not configured to read saved API keys, so the run did " +
  "not start. Nothing was sent to Anthropic. Please contact support.";
export const KEY_ENCRYPTION_UNCONFIGURED_CODE = "key_encryption_unconfigured";

export interface UserKeyFailure {
  error: string;
  code: string;
  status: number;
}

export type UserKeyResult = { key: string } | { failure: UserKeyFailure };

// Resolves the caller's key, or the reason it cannot be used.
//
// Returns the failure rather than throwing it. Throwing was the original
// design -- "failing loudly is right, because the alternative is sending
// garbage to Anthropic" -- and the first half of that still holds: a key
// that cannot be decrypted must never reach Anthropic. What was wrong was
// the loudness landing on the user. /api/execute calls this before its
// own try/catch, so the throw escaped to withRouteErrorHandling and the
// user saw "Internal server error." with no error id and nothing to act
// on, for what is in both cases a configuration problem with a specific
// remedy.
//
// Every failure is still logged server-side, and no path here logs,
// returns, or embeds the key or the secret -- EncryptionNotConfiguredError
// names only the variable, never its value.
export async function resolveUserAnthropicKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserKeyResult> {
  // Still throws: a failed SELECT is a genuine, unexpected database
  // fault, which is exactly what withRouteErrorHandling's generic 500 is
  // for. Only the decryptable/undecryptable distinction is handled here.
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("anthropic_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const stored = data?.anthropic_key_encrypted;
  if (!stored) {
    return {
      failure: {
        error: MISSING_KEY_MESSAGE,
        code: MISSING_KEY_CODE,
        status: 400,
      },
    };
  }

  try {
    return { key: decryptSecret(stored) };
  } catch (decryptError) {
    const unconfigured = decryptError instanceof EncryptionNotConfiguredError;
    console.error(
      unconfigured
        ? "[anthropic-key] API_KEY_ENCRYPTION_SECRET is unusable; stored keys cannot be decrypted"
        : "[anthropic-key] stored value could not be decrypted for this user",
      decryptError instanceof Error ? decryptError.message : "unknown",
    );
    return {
      failure: unconfigured
        ? {
            error: KEY_ENCRYPTION_UNCONFIGURED_MESSAGE,
            code: KEY_ENCRYPTION_UNCONFIGURED_CODE,
            // A server that is missing its own configuration is
            // unavailable, not a bad request.
            status: 503,
          }
        : {
            error: UNREADABLE_KEY_MESSAGE,
            code: UNREADABLE_KEY_CODE,
            status: 400,
          },
    };
  }
}
