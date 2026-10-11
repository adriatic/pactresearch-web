import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { http, HttpResponse } from "msw";
import { encryptSecret } from "@/lib/apiKeyCrypto";
import { plainTextToDoc } from "@/lib/richContent";
import { DISCUSSION_GONE, NOTEBOOK_GONE } from "@/lib/goneMessages";
import { server } from "../mocks/server";

// Task 84. Every action a stale tab can still send, aimed at a notebook or
// discussion that has been deleted (as by another tab): each must answer
// 404 with the plain message, and write nothing anywhere. Before task 84,
// Run answered a bare 500 "Internal server error." (the database refused
// its lock row) and the rest said "... not found.".

function runLocalSql(sql: string): void {
  execFileSync("npx", ["supabase", "db", "query", "--local", sql], {
    stdio: "inherit",
  });
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

const discussions = await import("@/app/api/discussions/route");
const notebooks = await import("@/app/api/notebooks/route");
const execute = await import("@/app/api/execute/route");
const discussionExport = await import("@/app/api/discussions/export/route");
const notebookExport = await import("@/app/api/notebooks/export/route");

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const plain = (url: string, method = "GET") =>
  new Request(`http://localhost${url}`, { method });

describe("actions on a deleted notebook or discussion", () => {
  let admin: SupabaseClient;
  let userId: string;
  let modelCalls = 0;
  const email = `deleted-target-${Date.now()}@example.com`;
  const password = "deleted target password 84!";

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    // Local-only grants, as in the other integration files.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks, " +
        "public.app_settings TO anon, authenticated, service_role;",
    );
    runLocalSql(
      "GRANT EXECUTE ON FUNCTION public.try_acquire_execution_lock" +
        "(uuid, uuid, interval) TO anon, authenticated, service_role;",
    );
    const status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf-8",
      }),
    ) as { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
    process.env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = status.ANON_KEY;
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString(
      "base64",
    );
    admin = createServiceClient(status.API_URL, status.SERVICE_ROLE_KEY);

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");
    userId = created.user.id;
    // A saved key, so Run gets past the "no key" check to the real path.
    await admin.from("user_api_keys").upsert({
      user_id: userId,
      anthropic_key_encrypted: encryptSecret("sk-ant-test-do-not-use"),
    });

    const jar: CookieRecord[] = [];
    const client = createServerClient(status.API_URL, status.ANON_KEY, {
      cookies: {
        getAll: () => jar,
        setAll: (all) =>
          all.forEach(({ name, value }) => {
            const e = jar.find((c) => c.name === name);
            if (e) e.value = value;
            else jar.push({ name, value });
          }),
      },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    currentCookies = jar;

    // The model must never be reached for a deleted discussion.
    server.listen({ onUnhandledRequest: "bypass" });
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        modelCalls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
  }, 120_000);

  afterAll(() => server.close());

  // A notebook with one discussion, then deleted -- as another tab does.
  async function deletedPair(what: "notebook" | "discussion") {
    const { data: nb } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: `nb ${Math.random()}` })
      .select()
      .single();
    const { data: d } = await admin
      .from("discussions")
      .insert({ notebook_id: nb!.id, user_id: userId, name: "d" })
      .select()
      .single();
    if (what === "notebook") {
      await admin.from("notebooks").delete().eq("id", nb!.id);
    } else {
      await admin.from("discussions").delete().eq("id", d!.id);
    }
    return { notebookId: nb!.id as string, discussionId: d!.id as string };
  }

  // Everything this user has, for "wrote nothing" checks.
  async function rowCounts() {
    const count = async (table: string) =>
      (
        await admin
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
      ).count;
    return {
      notebooks: await count("notebooks"),
      discussions: await count("discussions"),
      responses: await count("responses"),
      execution_locks: await count("execution_locks"),
      execution_timings: await count("execution_timings"),
    };
  }

  async function expectRefused(
    response: Response,
    message: string,
    before: Awaited<ReturnType<typeof rowCounts>>,
  ) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: message });
    expect(await rowCounts()).toEqual(before);
  }

  test("Run on a deleted discussion: plain message, no lock, no timing, no response, model not called", async () => {
    const { discussionId } = await deletedPair("discussion");
    const before = await rowCounts();
    const response = await execute.POST(
      json("/api/execute", "POST", {
        discussionId,
        promptContent: plainTextToDoc("hello"),
      }),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
    expect(modelCalls).toBe(0);
  });

  test("Run on a deleted discussion with an old, stale lock row present: same answer", async () => {
    // The lock's other path: an existing stale row is UPDATEd to point at
    // the requested discussion, rather than a new row INSERTed.
    const { data: live } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "live" })
      .select()
      .single();
    const { data: liveD } = await admin
      .from("discussions")
      .insert({ notebook_id: live!.id, user_id: userId, name: "live d" })
      .select()
      .single();
    await admin.from("execution_locks").insert({
      user_id: userId,
      discussion_id: liveD!.id,
      acquired_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    });
    const { discussionId } = await deletedPair("discussion");
    const before = await rowCounts();
    const response = await execute.POST(
      json("/api/execute", "POST", {
        discussionId,
        promptContent: plainTextToDoc("hello"),
      }),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
    // The stale lock still points at the live discussion, untouched.
    const { data: lock } = await admin
      .from("execution_locks")
      .select("discussion_id")
      .eq("user_id", userId)
      .single();
    expect(lock!.discussion_id).toBe(liveD!.id);
    expect(modelCalls).toBe(0);
    await admin.from("execution_locks").delete().eq("user_id", userId);
  });

  test("draft save on a deleted discussion", async () => {
    const { discussionId } = await deletedPair("discussion");
    const before = await rowCounts();
    const response = await discussions.PATCH(
      json(`/api/discussions?id=${discussionId}`, "PATCH", {
        draftContent: plainTextToDoc("unsent"),
      }),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
  });

  test("rename a deleted discussion", async () => {
    const { discussionId } = await deletedPair("notebook");
    const before = await rowCounts();
    const response = await discussions.PATCH(
      json(`/api/discussions?id=${discussionId}`, "PATCH", { name: "x" }),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
  });

  test("delete a deleted discussion", async () => {
    const { discussionId } = await deletedPair("discussion");
    const before = await rowCounts();
    const response = await discussions.DELETE(
      plain(`/api/discussions?id=${discussionId}`, "DELETE"),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
  });

  test("export a deleted discussion", async () => {
    const { discussionId } = await deletedPair("notebook");
    const before = await rowCounts();
    const response = await discussionExport.GET(
      plain(`/api/discussions/export?id=${discussionId}`),
    );
    await expectRefused(response, DISCUSSION_GONE, before);
  });

  test("Add discussion to a deleted notebook creates nothing", async () => {
    const { notebookId } = await deletedPair("notebook");
    const before = await rowCounts();
    const response = await discussions.POST(
      json("/api/discussions", "POST", { notebookId, name: "new" }),
    );
    await expectRefused(response, NOTEBOOK_GONE, before);
  });

  test("rename a deleted notebook, and change its settings", async () => {
    const { notebookId } = await deletedPair("notebook");
    const before = await rowCounts();
    await expectRefused(
      await notebooks.PATCH(
        json(`/api/notebooks?id=${notebookId}`, "PATCH", { name: "x" }),
      ),
      NOTEBOOK_GONE,
      before,
    );
    await expectRefused(
      await notebooks.PATCH(
        json(`/api/notebooks?id=${notebookId}`, "PATCH", {
          systemPrompt: "x",
        }),
      ),
      NOTEBOOK_GONE,
      before,
    );
  });

  test("delete a deleted notebook", async () => {
    const { notebookId } = await deletedPair("notebook");
    const before = await rowCounts();
    const response = await notebooks.DELETE(
      plain(`/api/notebooks?id=${notebookId}`, "DELETE"),
    );
    await expectRefused(response, NOTEBOOK_GONE, before);
  });

  test("export a deleted notebook", async () => {
    const { notebookId } = await deletedPair("notebook");
    const before = await rowCounts();
    const response = await notebookExport.GET(
      plain(`/api/notebooks/export?id=${notebookId}`),
    );
    await expectRefused(response, NOTEBOOK_GONE, before);
  });
});
