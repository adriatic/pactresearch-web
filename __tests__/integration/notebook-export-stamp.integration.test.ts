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

const { GET } = await import("@/app/api/notebooks/export/route");
const { POST: IMPORT } = await import("@/app/api/notebooks/import/route");

// Task 70. A .pact export says which build wrote it, from the same
// source as the build badge (lib/buildInfo.ts), so the two can never
// disagree. Vercel's own variables are set here as each environment
// would set them, then restored.

const VERCEL_KEYS = [
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_SLUG",
] as const;

function withVercelEnv<T>(
  env: Partial<Record<(typeof VERCEL_KEYS)[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = VERCEL_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of VERCEL_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return run().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("GET /api/notebooks/export: the build stamp", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );
    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
  }, 60000);

  async function signedInWithNotebook(): Promise<{
    cookies: CookieRecord[];
    notebookId: string;
    userId: string;
  }> {
    const email = `export-stamp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "correct horse battery staple 70!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");
    const cookies: CookieRecord[] = [];
    const jar = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => cookies,
        setAll: (toSet) =>
          toSet.forEach(({ name, value }) => {
            const existing = cookies.find((c) => c.name === name);
            if (existing) existing.value = value;
            else cookies.push({ name, value });
          }),
      },
    });
    const { error: signInError } = await jar.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    const { data: notebook } = await admin
      .from("notebooks")
      .insert({ user_id: created.user.id, name: "Stamp test" })
      .select()
      .single();
    return { cookies, notebookId: notebook!.id, userId: created.user.id };
  }

  async function exportNotebook(notebookId: string, cookies: CookieRecord[]) {
    currentCookies = cookies;
    const response = await GET(
      new Request(`http://localhost/api/notebooks/export?id=${notebookId}`),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  const SHA = "d337c4239a1b8c7e5f6a0b1c2d3e4f5a6b7c8d9e";

  test("on Production it records the environment, the full commit, and the badge's exact text", async () => {
    const { cookies, notebookId } = await signedInWithNotebook();
    const file = await withVercelEnv(
      {
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_SHA: SHA,
        VERCEL_GIT_REPO_OWNER: "adriatic",
        VERCEL_GIT_REPO_SLUG: "pactresearch-web",
      },
      async () => {
        const body = await exportNotebook(notebookId, cookies);
        // The badge's own label, computed the way BuildBadge computes it.
        const { getBuildInfo } = await import("@/lib/buildInfo");
        expect((body.exportedFrom as { build: string }).build).toBe(
          getBuildInfo().label,
        );
        return body;
      },
    );
    expect(file.exportedFrom).toEqual({
      app: "pact-web",
      environment: "production",
      commit: SHA,
      build: "Production · d337c42",
    });
    // Beside exportedAt, at the top of the file.
    expect(Object.keys(file).slice(0, 3)).toEqual([
      "version",
      "exportedAt",
      "exportedFrom",
    ]);
  });

  test("on a Preview it says Preview", async () => {
    const { cookies, notebookId } = await signedInWithNotebook();
    const file = await withVercelEnv(
      { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: SHA },
      () => exportNotebook(notebookId, cookies),
    );
    expect(file.exportedFrom).toEqual({
      app: "pact-web",
      environment: "preview",
      commit: SHA,
      build: "Preview · d337c42",
    });
  });

  test("on a developer's machine it says so, rather than inventing a build", async () => {
    const { cookies, notebookId } = await signedInWithNotebook();
    const file = await withVercelEnv({}, () =>
      exportNotebook(notebookId, cookies),
    );
    expect(file.exportedFrom).toEqual({
      app: "pact-web",
      environment: null,
      commit: null,
      build: "Local dev",
    });
  });

  test("a stamped file imports, and an older file without the stamp still imports", async () => {
    const { cookies, notebookId } = await signedInWithNotebook();
    const stamped = await withVercelEnv(
      { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: SHA },
      () => exportNotebook(notebookId, cookies),
    );
    const older = { ...stamped };
    delete older.exportedFrom;

    for (const file of [stamped, older]) {
      currentCookies = cookies;
      const response = await IMPORT(
        new Request("http://localhost/api/notebooks/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(file),
        }),
      );
      expect(response.status).toBe(201);
    }
  });
});
