import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Proves Realtime delivery on public.responses is actually scoped by the
// same RLS policy that scopes normal queries ("Users manage their own
// responses") — not just that a subscription mechanically works. A
// subscribed user must receive events for their own rows and must not
// receive events for another user's rows on the same table.

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

// Polls instead of a fixed sleep for the "should be delivered" case, so the
// test resolves as soon as the event actually arrives (fast on a quiet
// machine) rather than flaking under load when the full suite's other
// files are contending for the same local Postgres/Realtime containers.
async function waitUntil(
  condition: () => boolean,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("Realtime delivery for public.responses respects RLS", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB —
    // files run sequentially (fileParallelism: false) so resets across
    // integration files can't race each other. This also picks up
    // 20260903183756_responses_realtime_publication.sql, without which
    // the subscription below would just never fire.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

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
    const email = `realtime-rls-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 6!";

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

  async function seedDiscussion(userId: string): Promise<string> {
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Realtime test notebook" })
      .select()
      .single();
    if (notebookError || !notebook) {
      throw notebookError ?? new Error("failed to seed notebook");
    }

    const { data: discussion, error: discussionError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Realtime test discussion",
      })
      .select()
      .single();
    if (discussionError || !discussion) {
      throw discussionError ?? new Error("failed to seed discussion");
    }

    return discussion.id as string;
  }

  test("a subscriber receives their own row's events and never another user's", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();
    const discussionA = await seedDiscussion(userA.userId);
    const discussionB = await seedDiscussion(userB.userId);

    const receivedByA: Array<Record<string, unknown>> = [];
    const channel = userA.client
      .channel(`test-responses-${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "responses" },
        (payload) => {
          receivedByA.push(payload.new);
        },
      );

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Realtime subscription timed out")),
          10000,
        );
        channel.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(err ?? new Error(`Realtime subscribe failed: ${status}`));
          }
        });
      });

      // User B's row: RLS must prevent this reaching User A's subscription.
      const { error: insertBError } = await admin.from("responses").insert({
        discussion_id: discussionB,
        user_id: userB.userId,
        prompt_text: "b prompt",
      });
      expect(insertBError).toBeNull();

      // Give Realtime a real window to (not) deliver it. This one has to
      // be a fixed wait, not a poll — we're proving an absence, so there's
      // no "done" condition to poll for other than time passing.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(receivedByA).toHaveLength(0);

      // User A's own row: must be delivered.
      const { data: insertedA, error: insertAError } = await admin
        .from("responses")
        .insert({
          discussion_id: discussionA,
          user_id: userA.userId,
          prompt_text: "a prompt",
        })
        .select()
        .single();
      expect(insertAError).toBeNull();

      await waitUntil(() => receivedByA.length > 0, {
        timeoutMs: 15000,
        intervalMs: 100,
      });
      expect(receivedByA).toHaveLength(1);
      expect(receivedByA[0].id).toBe(insertedA!.id);
      expect(receivedByA[0].discussion_id).toBe(discussionA);
    } finally {
      await userA.client.removeChannel(channel);
    }
  }, 30000);
});
