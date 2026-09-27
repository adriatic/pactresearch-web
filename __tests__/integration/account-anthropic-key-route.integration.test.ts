import { beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Saving an Anthropic key, with the server's encryption secret missing.
//
// The 2026-09-27 outage had two faces. Running showed "Internal server
// error." (covered in execute-route's own tests), and so did SAVING --
// which is worse, because saving is what someone does to try to fix it:
// the one screen offering a remedy failed the same opaque way, with
// nothing stored and nothing said about why.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
}

type CookieRecord = { name: string; value: string };
let currentCookies: CookieRecord[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => currentCookies,
    get: (name: string) => currentCookies.find((c) => c.name === name),
    set: () => {},
  }),
}));

const { POST } = await import("@/app/api/account/anthropic-key/route");

describe("/api/account/anthropic-key", () => {
  let admin: SupabaseClient;
  let API_URL: string;
  let ANON_KEY: string;

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 120000);

  async function signedInUser() {
    const email = `account-key-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 57!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");

    const jar: CookieRecord[] = [];
    const jarClient = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => jar,
        setAll: (cs) =>
          cs.forEach(({ name, value }) => {
            const e = jar.find((c) => c.name === name);
            if (e) e.value = value;
            else jar.push({ name, value });
          }),
      },
    });
    const { error: signInError } = await jarClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    return { userId: created.user.id, cookies: jar };
  }

  function saveRequest(key: string) {
    return new Request("http://localhost/api/account/anthropic-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
  }

  test("saving with no usable encryption secret says so, and stores nothing", async () => {
    const { userId, cookies } = await signedInUser();
    currentCookies = cookies;

    const secret = process.env.API_KEY_ENCRYPTION_SECRET;
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    try {
      const response = await POST(saveRequest("sk-ant-some-real-looking-key"));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.code).toBe("key_encryption_unconfigured");
      expect(body.error).not.toMatch(/internal server error/i);
      // Must not imply the key was kept when it was not.
      expect(body.error).toMatch(/not saved/i);
      // Never names the secret, and never echoes the key.
      expect(body.error).not.toMatch(/API_KEY_ENCRYPTION_SECRET/);
      expect(body.error).not.toMatch(/sk-ant/);

      const { data: rows } = await admin
        .from("user_api_keys")
        .select("user_id")
        .eq("user_id", userId);
      expect(rows).toHaveLength(0);
    } finally {
      process.env.API_KEY_ENCRYPTION_SECRET = secret;
    }
  }, 60000);

  test("saving works normally once the secret is configured", async () => {
    const { userId, cookies } = await signedInUser();
    currentCookies = cookies;
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 3).toString(
      "base64",
    );

    const response = await POST(saveRequest("sk-ant-another-real-looking-key"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.hasKey).toBe(true);

    const { data: row } = await admin
      .from("user_api_keys")
      .select("anthropic_key_encrypted")
      .eq("user_id", userId)
      .single();
    // Stored, and genuinely not the plaintext.
    expect(row?.anthropic_key_encrypted).toBeTruthy();
    expect(row?.anthropic_key_encrypted).not.toContain("sk-ant");
  }, 60000);
});
