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

const { POST } = await import("@/app/api/notebooks/route");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/notebooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/notebooks", () => {
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
    const email = `notebooks-route-${Date.now()}-${Math.random()
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

  test("creates a notebook owned by the caller", async () => {
    const { userId, cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await POST(
      makeRequest({
        name: "My Notebook",
        category: "Personal Research",
        systemPrompt: "Be concise.",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.user_id).toBe(userId);
    expect(body.name).toBe("My Notebook");
    expect(body.category).toBe("Personal Research");
    expect(body.system_prompt).toBe("Be concise.");

    const { data: rows, error } = await admin
      .from("notebooks")
      .select("*")
      .eq("id", body.id);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].user_id).toBe(userId);
  });

  test("returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await POST(makeRequest({ name: "Nope" }));

    expect(response.status).toBe(401);
  });

  test("returns 400 for an invalid category", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await POST(
      makeRequest({ name: "Bad category", category: "Samples" }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test("returns 400 for a malformed request body", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;

    const response = await POST(
      new Request("http://localhost/api/notebooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json{{{",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });
});
