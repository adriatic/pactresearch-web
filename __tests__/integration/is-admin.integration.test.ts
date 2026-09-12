import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { isAdmin } from "@/lib/isAdmin";

// Proves lib/isAdmin.ts (backed by the RLS policy added in
// 20260912173629_user_roles_is_admin) behaves correctly for an admin
// user, a non-admin user, and a user with no user_roles row at all --
// and that RLS actually isolates the table: a user can only ever read
// their own row, and has no write path to it at all (granting admin is a
// direct-SQL operator action, not something the app can do).

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

describe("isAdmin / user_roles RLS", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB --
    // files run sequentially (fileParallelism: false in
    // vitest.integration.config.mts) so the resets can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant, same reasoning as the other integration tests: the
    // hosted project already has these grants by default, the local CLI
    // stack does not. Granting insert/update/delete to authenticated here
    // doesn't open a write path -- there's no RLS policy permitting those
    // commands for authenticated, so they still affect zero rows; this
    // grant only lets the *attempt* reach RLS instead of being rejected
    // earlier at the privilege level, which is what the isolation tests
    // below actually need to exercise.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles " +
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
    const email = `is-admin-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 4!";

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

  test("returns true for a user whose row has is_admin = true", async () => {
    const { userId, client } = await createSignedInUser();
    const { error } = await admin
      .from("user_roles")
      .insert({ user_id: userId, is_admin: true });
    expect(error).toBeNull();

    await expect(isAdmin(client, userId)).resolves.toBe(true);
  });

  test("returns false for a user whose row has is_admin = false", async () => {
    const { userId, client } = await createSignedInUser();
    const { error } = await admin
      .from("user_roles")
      .insert({ user_id: userId, is_admin: false });
    expect(error).toBeNull();

    await expect(isAdmin(client, userId)).resolves.toBe(false);
  });

  test("returns false for a user with no user_roles row at all", async () => {
    const { userId, client } = await createSignedInUser();

    await expect(isAdmin(client, userId)).resolves.toBe(false);
  });

  test("User A cannot read User B's admin status", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const { error: seedError } = await admin
      .from("user_roles")
      .insert({ user_id: userB.userId, is_admin: true });
    expect(seedError).toBeNull();

    // Directly querying User B's row as User A returns nothing (RLS
    // hides it, it isn't an error) -- and isAdmin(), which is exactly
    // this query, must therefore report User A as not admin even though
    // User B genuinely is.
    const { data: selected, error: selectError } = await userA.client
      .from("user_roles")
      .select("is_admin")
      .eq("user_id", userB.userId);
    expect(selectError).toBeNull();
    expect(selected).toHaveLength(0);

    await expect(isAdmin(userA.client, userB.userId)).resolves.toBe(false);

    // Regression check: User B's own view of their own row is unaffected.
    await expect(isAdmin(userB.client, userB.userId)).resolves.toBe(true);
  });

  test("a user cannot grant themselves admin -- no write policy exists at all", async () => {
    const { userId, client } = await createSignedInUser();

    // No existing row: an authenticated user cannot insert one for
    // themselves either (there is no insert policy, self-targeted or
    // not). Unlike select/update/delete -- where "no policy" just means
    // the row is filtered out, silently affecting zero rows -- Postgres
    // RLS rejects an insert with no applicable policy outright: there's
    // no existing row for a USING clause to filter, so it's a hard error
    // rather than a silent no-op.
    const { data: inserted, error: insertError } = await client
      .from("user_roles")
      .insert({ user_id: userId, is_admin: true })
      .select();
    expect(insertError?.code).toBe("42501");
    expect(inserted).toBeNull();

    const { data: afterInsertAttempt, error: afterInsertError } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    expect(afterInsertError).toBeNull();
    expect(afterInsertAttempt).toBeNull();

    // Now seed a real (non-admin) row via the service client, then try to
    // flip it from the authenticated client.
    const { error: seedError } = await admin
      .from("user_roles")
      .insert({ user_id: userId, is_admin: false });
    expect(seedError).toBeNull();

    const { data: updated, error: updateError } = await client
      .from("user_roles")
      .update({ is_admin: true })
      .eq("user_id", userId)
      .select();
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(0);

    const { data: afterUpdateAttempt, error: afterUpdateError } = await admin
      .from("user_roles")
      .select("is_admin")
      .eq("user_id", userId)
      .single();
    expect(afterUpdateError).toBeNull();
    expect(afterUpdateAttempt?.is_admin).toBe(false);

    await expect(isAdmin(client, userId)).resolves.toBe(false);
  });
});
