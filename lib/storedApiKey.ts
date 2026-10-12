import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret,
  EncryptionNotConfiguredError,
} from "@/lib/apiKeyCrypto";

// Task 51's key lookup, shared since Task 81 by the Anthropic and OpenAI
// keys: the two differ only in their column and in what the messages
// say. Server-only: it decrypts.

// The server has no usable API_KEY_ENCRYPTION_SECRET: the same code for
// every key, since it is the same secret.
export const KEY_ENCRYPTION_UNCONFIGURED_CODE = "key_encryption_unconfigured";

export interface UserKeyFailure {
  error: string;
  code: string;
  status: number;
}

export type UserKeyResult = { key: string } | { failure: UserKeyFailure };

export interface StoredKeySpec {
  column: "anthropic_key_encrypted" | "openai_key_encrypted";
  // The tag on this key's log lines, e.g. "anthropic-key".
  logTag: string;
  missing: { error: string; code: string };
  unreadable: { error: string; code: string };
  unconfigured: string;
}

// Resolves the caller's key, or the reason it cannot be used.
//
// Returns the failure rather than throwing it. Throwing was the original
// design -- "failing loudly is right, because the alternative is sending
// garbage to Anthropic" -- and the first half of that still holds: a key
// that cannot be decrypted must never reach the model service. What was
// wrong was the loudness landing on the user. /api/execute calls this
// before its own try/catch, so the throw escaped to
// withRouteErrorHandling and the user saw "Internal server error." with
// no error id and nothing to act on, for what is in both cases a
// configuration problem with a specific remedy.
//
// Every failure is still logged server-side, and no path here logs,
// returns, or embeds the key or the secret -- EncryptionNotConfiguredError
// names only the variable, never its value.
export async function resolveStoredKey(
  supabase: SupabaseClient,
  userId: string,
  spec: StoredKeySpec,
): Promise<UserKeyResult> {
  // Still throws: a failed SELECT is a genuine, unexpected database
  // fault, which is exactly what withRouteErrorHandling's generic 500 is
  // for. Only the decryptable/undecryptable distinction is handled here.
  const { data, error } = await supabase
    .from("user_api_keys")
    .select(spec.column)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const stored = (data as Record<string, string | null> | null)?.[spec.column];
  if (!stored) {
    return { failure: { ...spec.missing, status: 400 } };
  }

  try {
    return { key: decryptSecret(stored) };
  } catch (decryptError) {
    const unconfigured = decryptError instanceof EncryptionNotConfiguredError;
    console.error(
      unconfigured
        ? `[${spec.logTag}] API_KEY_ENCRYPTION_SECRET is unusable; stored keys cannot be decrypted`
        : `[${spec.logTag}] stored value could not be decrypted for this user`,
      decryptError instanceof Error ? decryptError.message : "unknown",
    );
    return {
      failure: unconfigured
        ? {
            error: spec.unconfigured,
            code: KEY_ENCRYPTION_UNCONFIGURED_CODE,
            // A server that is missing its own configuration is
            // unavailable, not a bad request.
            status: 503,
          }
        : { ...spec.unreadable, status: 400 },
    };
  }
}
