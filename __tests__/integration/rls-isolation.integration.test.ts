import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Proves the RLS policies added in 20260903035641 actually isolate users
// from each other, not just that a user can reach their own rows (which
// would also pass with RLS disabled entirely — the gap that went unnoticed
// until now). For each of notebooks/discussions/responses: User A must not
// be able to select, update, or delete a row owned by User B, and User A's
// own read/write access must still work (regression check).

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

type TableName = "notebooks" | "discussions" | "responses";

describe("notebooks/discussions/responses RLS isolation", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB —
    // files run sequentially (fileParallelism: false in
    // vitest.integration.config.mts) so the resets can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant, same reasoning as the other integration tests: the
    // hosted project already has these grants by default (confirmed via
    // `supabase db query --linked`), the local CLI stack does not.
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
    const email = `rls-isolation-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 3!";

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

  async function seedNotebookDiscussionResponse(
    client: SupabaseClient,
    userId: string,
  ): Promise<{ notebookId: string; discussionId: string; responseId: string }> {
    const { data: notebook, error: notebookError } = await client
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook" })
      .select("id")
      .single();
    if (notebookError || !notebook) {
      throw notebookError ?? new Error("failed to seed notebook");
    }

    const { data: discussion, error: discussionError } = await client
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Discussion",
      })
      .select("id")
      .single();
    if (discussionError || !discussion) {
      throw discussionError ?? new Error("failed to seed discussion");
    }

    const { data: response, error: responseError } = await client
      .from("responses")
      .insert({
        discussion_id: discussion.id,
        user_id: userId,
        prompt_text: "prompt",
      })
      .select("id")
      .single();
    if (responseError || !response) {
      throw responseError ?? new Error("failed to seed response");
    }

    return {
      notebookId: notebook.id,
      discussionId: discussion.id,
      responseId: response.id,
    };
  }

  // Confirms actingClient (User A) cannot select, update, or delete a row
  // it doesn't own — asserting on the actual response content (empty
  // arrays, admin-verified untouched state), never just "it didn't throw".
  async function assertCannotAccessOthersRow(params: {
    table: TableName;
    actingClient: SupabaseClient;
    targetRowId: string;
    targetOwnerId: string;
    updatePatch: Record<string, unknown>;
  }) {
    const { table, actingClient, targetRowId, targetOwnerId, updatePatch } =
      params;

    const { data: selected, error: selectError } = await actingClient
      .from(table)
      .select("*")
      .eq("id", targetRowId);
    expect(selectError).toBeNull();
    expect(selected).toHaveLength(0);

    const { data: updated, error: updateError } = await actingClient
      .from(table)
      .update(updatePatch)
      .eq("id", targetRowId)
      .select();
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(0);

    const { data: afterUpdate, error: afterUpdateError } = await admin
      .from(table)
      .select("*")
      .eq("id", targetRowId)
      .single();
    expect(afterUpdateError).toBeNull();
    expect(afterUpdate?.user_id).toBe(targetOwnerId);
    for (const [key, value] of Object.entries(updatePatch)) {
      expect((afterUpdate as Record<string, unknown>)[key]).not.toBe(value);
    }

    const { data: deleted, error: deleteError } = await actingClient
      .from(table)
      .delete()
      .eq("id", targetRowId)
      .select();
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(0);

    const { data: afterDelete, error: afterDeleteError } = await admin
      .from(table)
      .select("id")
      .eq("id", targetRowId)
      .maybeSingle();
    expect(afterDeleteError).toBeNull();
    expect(afterDelete).not.toBeNull();
  }

  // Regression check: the new policies must not have broken legitimate
  // same-user access. Uses a dedicated row so it doesn't disturb the
  // fixtures the isolation checks above depend on.
  async function assertOwnAccessStillWorks(
    client: SupabaseClient,
    userId: string,
  ) {
    const { data: notebook, error: insertError } = await client
      .from("notebooks")
      .insert({ user_id: userId, name: "Own regression notebook" })
      .select()
      .single();
    expect(insertError).toBeNull();
    expect(notebook).toBeTruthy();

    const { data: selected, error: selectError } = await client
      .from("notebooks")
      .select("*")
      .eq("id", notebook!.id);
    expect(selectError).toBeNull();
    expect(selected).toHaveLength(1);

    const { data: updated, error: updateError } = await client
      .from("notebooks")
      .update({ name: "Renamed" })
      .eq("id", notebook!.id)
      .select();
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
    expect(updated?.[0].name).toBe("Renamed");

    const { data: deleted, error: deleteError } = await client
      .from("notebooks")
      .delete()
      .eq("id", notebook!.id)
      .select();
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  }

  test("User A cannot select, update, or delete User B's notebook, discussion, or response", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const seededB = await seedNotebookDiscussionResponse(
      userB.client,
      userB.userId,
    );

    await assertCannotAccessOthersRow({
      table: "notebooks",
      actingClient: userA.client,
      targetRowId: seededB.notebookId,
      targetOwnerId: userB.userId,
      updatePatch: { name: "hacked" },
    });

    await assertCannotAccessOthersRow({
      table: "discussions",
      actingClient: userA.client,
      targetRowId: seededB.discussionId,
      targetOwnerId: userB.userId,
      updatePatch: { name: "hacked" },
    });

    await assertCannotAccessOthersRow({
      table: "responses",
      actingClient: userA.client,
      targetRowId: seededB.responseId,
      targetOwnerId: userB.userId,
      updatePatch: { response: "hacked" },
    });
  });

  test("User A can still fully read/write their own notebooks (regression check)", async () => {
    const userA = await createSignedInUser();
    await assertOwnAccessStillWorks(userA.client, userA.userId);
  });

  test("a broad select never returns another user's rows", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const seededA = await seedNotebookDiscussionResponse(
      userA.client,
      userA.userId,
    );
    const seededB = await seedNotebookDiscussionResponse(
      userB.client,
      userB.userId,
    );

    const { data: notebooksSeenByA, error: notebooksError } = await userA.client
      .from("notebooks")
      .select("id, user_id");
    expect(notebooksError).toBeNull();
    expect(notebooksSeenByA?.every((row) => row.user_id === userA.userId)).toBe(
      true,
    );
    expect(notebooksSeenByA?.some((row) => row.id === seededB.notebookId)).toBe(
      false,
    );
    expect(notebooksSeenByA?.some((row) => row.id === seededA.notebookId)).toBe(
      true,
    );

    const { data: discussionsSeenByA, error: discussionsError } =
      await userA.client.from("discussions").select("id, user_id");
    expect(discussionsError).toBeNull();
    expect(
      discussionsSeenByA?.every((row) => row.user_id === userA.userId),
    ).toBe(true);
    expect(
      discussionsSeenByA?.some((row) => row.id === seededB.discussionId),
    ).toBe(false);

    const { data: responsesSeenByA, error: responsesError } = await userA.client
      .from("responses")
      .select("id, user_id");
    expect(responsesError).toBeNull();
    expect(responsesSeenByA?.every((row) => row.user_id === userA.userId)).toBe(
      true,
    );
    expect(responsesSeenByA?.some((row) => row.id === seededB.responseId)).toBe(
      false,
    );
  });
});
