import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStoredKey, type UserKeyResult } from "./storedApiKey";

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
export { KEY_ENCRYPTION_UNCONFIGURED_CODE } from "./storedApiKey";

// Task 58. The key decrypted fine and reached Anthropic, which refused
// it -- revoked, mistyped, or belonging to another account. Distinct
// from every failure above, all of which are detectable before the
// request is made.
//
// This is the case a real user is most likely to hit, and until now it
// produced the least useful of the four messages: the generic
// "Execution failed. Please try again or contact support", which points
// at us when the remedy is entirely theirs.
export const REJECTED_KEY_MESSAGE =
  "Anthropic rejected your API key. Check it in Account → Keys.";
export const REJECTED_KEY_CODE = "anthropic_rejected_key";

// Whether an Anthropic HTTP status means "this key is not acceptable".
//
// 401 only, deliberately. Anthropic also returns 403 for a permission
// problem, but that is an account or entitlement issue rather than a
// wrong key -- telling someone to re-check a key that is perfectly
// valid would send them to fix the one thing that is not broken. A 403
// keeps the generic message and its error id, which is the right
// outcome for something needing a human to look at the account.
export function isAnthropicKeyRejection(status: number): boolean {
  return status === 401;
}

export type { UserKeyFailure, UserKeyResult } from "./storedApiKey";

// Resolves the caller's key, or the reason it cannot be used. The
// lookup itself is shared with the OpenAI key since Task 81
// (lib/storedApiKey.ts); the messages are Anthropic's, unchanged.
export async function resolveUserAnthropicKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserKeyResult> {
  return resolveStoredKey(supabase, userId, {
    column: "anthropic_key_encrypted",
    logTag: "anthropic-key",
    missing: { error: MISSING_KEY_MESSAGE, code: MISSING_KEY_CODE },
    unreadable: { error: UNREADABLE_KEY_MESSAGE, code: UNREADABLE_KEY_CODE },
    unconfigured: KEY_ENCRYPTION_UNCONFIGURED_MESSAGE,
  });
}
