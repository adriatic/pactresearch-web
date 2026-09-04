import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { ensureDiscussion } from "@/lib/ensureDiscussion";

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function runLocalSql(sql: string): void {
  execFileSync("npx", ["supabase", "db", "query", "--local", sql], {
    stdio: "inherit",
  });
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

describe("ensureDiscussion", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB —
    // files run sequentially (fileParallelism: false) so this can't race
    // the other integration files' own resets.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant, same reasoning as the execute-route integration
    // test: the hosted project already has these grants by default, the
    // local CLI stack does not.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(): Promise<{
    userId: string;
    client: SupabaseClient;
  }> {
    const email = `ensure-discussion-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 2!";

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw createError ?? new Error("failed to create test user");
    }

    const cookies: { name: string; value: string }[] = [];
    const client = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => cookies,
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => {
            const existing = cookies.find((c) => c.name === name);
            if (existing) {
              existing.value = value;
            } else {
              cookies.push({ name, value });
            }
          });
        },
      },
    });

    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    return { userId: created.user.id, client };
  }

  test("creates exactly one discussion for a user with none", async () => {
    const { userId, client } = await createSignedInUser();

    const discussionId = await ensureDiscussion(client, userId);
    expect(discussionId).toBeTruthy();

    const { data: rows, error } = await admin
      .from("discussions")
      .select("id")
      .eq("user_id", userId);

    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].id).toBe(discussionId);
  });

  test("reuses the existing discussion on a second call, without duplicating", async () => {
    const { userId, client } = await createSignedInUser();

    const first = await ensureDiscussion(client, userId);
    const second = await ensureDiscussion(client, userId);

    expect(second).toBe(first);

    const { data: rows, error } = await admin
      .from("discussions")
      .select("id")
      .eq("user_id", userId);

    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
  });
});
