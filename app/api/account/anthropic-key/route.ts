import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { decryptSecret, encryptSecret, keyHint } from "@/lib/apiKeyCrypto";

// Task 51. The user's own Anthropic API key: save, check, and the
// deliberate reveal behind the Keys tab's "show" toggle.
//
// Every path here requires an authenticated session and only ever
// touches THAT user's row -- there is no way to name another user's
// key. RLS enforces the same thing underneath, so this is belt and
// braces rather than the only guard.
//
// Plaintext appears in exactly one response in this file: the reveal,
// which is the feature. It is never logged anywhere, and never included
// in an error.

// Anthropic keys start sk-ant-. Checked so an obvious paste mistake is
// caught here rather than surfacing as a confusing 401 on the user's
// next run.
const KEY_PREFIX = "sk-ant-";
const MAX_KEY_LENGTH = 500;

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
    .select("anthropic_key_encrypted")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;

  const stored = data?.anthropic_key_encrypted ?? null;
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
      "[anthropic-key] stored value could not be decrypted for this user",
      decryptError instanceof Error ? decryptError.message : "unknown",
    );
    return Response.json(
      {
        error: "Your saved key could not be read. Please re-enter and save it.",
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
      { error: "Enter your Anthropic API key." },
      { status: 400 },
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    return Response.json({ error: "That key is too long." }, { status: 400 });
  }
  if (!key.startsWith(KEY_PREFIX)) {
    return Response.json(
      { error: `An Anthropic API key starts with "${KEY_PREFIX}".` },
      { status: 400 },
    );
  }

  const encrypted = encryptSecret(key);

  const { error } = await supabase.from("user_api_keys").upsert(
    {
      user_id: user.id,
      anthropic_key_encrypted: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;

  // Deliberately does not echo the key back.
  return Response.json({ hasKey: true, hint: keyHint(key) });
}

export const GET = withRouteErrorHandling(handleGet);
export const POST = withRouteErrorHandling(handlePost);
