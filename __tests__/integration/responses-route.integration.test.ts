import { beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

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

type CookieRecord = { name: string; value: string };

// The route reads the session via next/headers' cookies(), which only works
// inside Next's own request-scoped AsyncLocalStorage. Since we call the
// route handler directly (not through a running Next server), next/headers
// is mocked so cookies() returns whatever this test currently wants the
// "incoming request" to carry.
let currentCookies: CookieRecord[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => currentCookies,
    get: (name: string) => currentCookies.find((c) => c.name === name),
    set: () => {},
  }),
}));

const { GET } = await import("@/app/api/responses/route");

function makeRequest(discussionId: string) {
  return new Request(
    `http://localhost/api/responses?discussionId=${discussionId}`,
  );
}

describe("GET /api/responses", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB —
    // files run sequentially (fileParallelism: false) so resets across
    // integration files can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Local-only grant: the hosted project already grants these by
    // default, the local CLI stack does not (see other integration tests
    // for the same reasoning).
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    // The route itself calls utils/supabase/server.ts's createClient(),
    // which reads these directly — each integration test file runs in its
    // own isolated worker, so this has to be set here too, not just in
    // execute-route's beforeAll.
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function createSignedInUser(): Promise<{
    userId: string;
    cookies: CookieRecord[];
  }> {
    const email = `responses-route-${Date.now()}-${Math.random()
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

    const cookies: CookieRecord[] = [];
    const jarClient = createServerClient(API_URL, ANON_KEY, {
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

    const { error: signInError } = await jarClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    return { userId: created.user.id, cookies };
  }

  test("returns the caller's own discussion's responses in chronological order", async () => {
    const { userId, cookies } = await createSignedInUser();

    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook for responses test" })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const { data: discussion, error: discussionError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook!.id,
        user_id: userId,
        name: "Discussion for responses test",
      })
      .select()
      .single();
    expect(discussionError).toBeNull();

    // Inserted out of chronological order, with explicit created_at values,
    // so an ascending sort is actually exercised rather than incidentally
    // matching insertion order.
    const { error: insertError } = await admin.from("responses").insert([
      {
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: "second prompt",
        response: "second response",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-07T00:02:00Z",
      },
      {
        discussion_id: discussion!.id,
        user_id: userId,
        prompt_text: "first prompt",
        response: "first response",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-07T00:01:00Z",
      },
    ]);
    expect(insertError).toBeNull();

    currentCookies = cookies;
    const response = await GET(makeRequest(discussion!.id));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toHaveLength(2);
    expect(body[0].prompt_text).toBe("first prompt");
    expect(body[1].prompt_text).toBe("second prompt");
  });

  test("returns 404, not another user's data, when the discussion belongs to another user", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const { data: notebookA, error: notebookAError } = await admin
      .from("notebooks")
      .insert({ user_id: userA.userId, name: "User A's notebook" })
      .select()
      .single();
    expect(notebookAError).toBeNull();

    const { data: discussionA, error: discussionAError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebookA!.id,
        user_id: userA.userId,
        name: "User A's discussion",
      })
      .select()
      .single();
    expect(discussionAError).toBeNull();

    const { error: responseError } = await admin.from("responses").insert({
      discussion_id: discussionA!.id,
      user_id: userA.userId,
      prompt_text: "User A's prompt",
      response: "User A's response",
    });
    expect(responseError).toBeNull();

    currentCookies = userB.cookies;
    const response = await GET(makeRequest(discussionA!.id));

    expect(response.status).toBe(404);
  });

  test("returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await GET(
      makeRequest("00000000-0000-0000-0000-000000000000"),
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 when discussionId is missing", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await GET(new Request("http://localhost/api/responses"));

    expect(response.status).toBe(400);
  });
});
