import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { decryptSecret, encryptSecret, keyHint } from "@/lib/apiKeyCrypto";
import { KEY_ENCRYPTION_UNCONFIGURED_CODE } from "@/lib/storedApiKey";

// Task 51. The user's own API key: save, check, and the deliberate
// reveal behind the Keys tab's "show" toggle. Written for the Anthropic
// key; since Task 81 the same handlers serve the OpenAI key, built from a
// KeyRouteSpec (app/api/account/anthropic-key, .../openai-key).
//
// Every path here requires an authenticated session and only ever
// touches THAT user's row -- there is no way to name another user's
// key. RLS enforces the same thing underneath, so this is belt and
// braces rather than the only guard.
//
// Plaintext appears in exactly one response in this file: the reveal,
// which is the feature. It is never logged anywhere, and never included
// in an error.

const MAX_KEY_LENGTH = 500;

export interface KeyRouteSpec {
  column: "anthropic_key_encrypted" | "openai_key_encrypted";
  // The tag on this key's log lines, e.g. "anthropic-key".
  logTag: string;
  // "Enter your <name>.", e.g. "Anthropic API key".
  name: string;
  // Checked so an obvious paste mistake is caught here rather than
  // surfacing as a confusing 401 on the user's next run.
  prefix: string;
  prefixMessage: string;
  // A further paste mistake to catch (e.g. the other service's key in
  // this field), checked after the prefix.
  wrongKey?: { test: (key: string) => boolean; message: string };
}

export function makeApiKeyRoute(spec: KeyRouteSpec) {
  async function requireUser() {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { supabase, user };
  }

  // GET            -> { hasKey, hint }   (no plaintext)
  // GET ?reveal=1  -> { key }            (the "show" toggle)
  async function handleGet(request: Request): Promise<Response> {
    const { supabase, user } = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("user_api_keys")
      .select(spec.column)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    const stored =
      (data as Record<string, string | null> | null)?.[spec.column] ?? null;
    const reveal = new URL(request.url).searchParams.get("reveal") === "1";

    if (!stored) {
      return Response.json(
        reveal ? { key: null } : { hasKey: false, hint: null },
      );
    }

    let plaintext: string;
    try {
      plaintext = decryptSecret(stored);
    } catch (decryptError) {
      // Logged WITHOUT the value: this fires when the row was written
      // under a different API_KEY_ENCRYPTION_SECRET, which is a real
      // operational situation (secret rotated, or an environment pointed
      // at another deployment's data) and needs to be diagnosable.
      console.error(
        `[${spec.logTag}] stored value could not be decrypted for this user`,
        decryptError instanceof Error ? decryptError.message : "unknown",
      );
      return Response.json(
        {
          error:
            "Your saved key could not be read. Please re-enter and save it.",
        },
        { status: 500 },
      );
    }

    return reveal
      ? Response.json({ key: plaintext })
      : Response.json({ hasKey: true, hint: keyHint(plaintext) });
  }

  async function handlePost(request: Request): Promise<Response> {
    const { supabase, user } = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json()) as { key?: unknown };
    const key = typeof body.key === "string" ? body.key.trim() : "";

    if (!key) {
      return Response.json(
        { error: `Enter your ${spec.name}.` },
        { status: 400 },
      );
    }
    if (key.length > MAX_KEY_LENGTH) {
      return Response.json({ error: "That key is too long." }, { status: 400 });
    }
    if (!key.startsWith(spec.prefix)) {
      return Response.json({ error: spec.prefixMessage }, { status: 400 });
    }
    if (spec.wrongKey?.test(key)) {
      return Response.json({ error: spec.wrongKey.message }, { status: 400 });
    }

    // Saving hit the same unhandled-throw problem as running: with no
    // usable API_KEY_ENCRYPTION_SECRET, encryptSecret threw and the user
    // got "Internal server error." while trying to fix the very thing
    // that was broken. Nothing is stored in that case, so saying so
    // plainly is both accurate and the only useful thing to say.
    let encrypted: string;
    try {
      encrypted = encryptSecret(key);
    } catch (encryptError) {
      console.error(
        `[${spec.logTag}] could not encrypt: API_KEY_ENCRYPTION_SECRET is unusable`,
        encryptError instanceof Error ? encryptError.message : "unknown",
      );
      return Response.json(
        {
          error:
            "This server is not configured to store API keys yet, so your " +
            "key was not saved. Please contact support.",
          code: KEY_ENCRYPTION_UNCONFIGURED_CODE,
        },
        { status: 503 },
      );
    }

    const { error } = await supabase.from("user_api_keys").upsert(
      {
        user_id: user.id,
        [spec.column]: encrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;

    // Deliberately does not echo the key back.
    return Response.json({ hasKey: true, hint: keyHint(key) });
  }

  return {
    GET: withRouteErrorHandling(handleGet),
    POST: withRouteErrorHandling(handlePost),
  };
}
