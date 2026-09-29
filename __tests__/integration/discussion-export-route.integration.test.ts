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

const { GET } = await import("@/app/api/discussions/export/route");

function makeRequest(discussionId: string) {
  return new Request(
    `http://localhost/api/discussions/export?id=${discussionId}`,
  );
}

describe("GET /api/discussions/export", () => {
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
    const email = `discussion-export-${Date.now()}-${Math.random()
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

  async function seedNotebookAndDiscussion(
    userId: string,
    notebookName: string,
    discussionName: string,
  ): Promise<{ notebookId: string; discussionId: string }> {
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: notebookName })
      .select()
      .single();
    expect(notebookError).toBeNull();

    const { data: discussion, error: discussionError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook!.id,
        user_id: userId,
        name: discussionName,
      })
      .select()
      .single();
    expect(discussionError).toBeNull();

    return { notebookId: notebook!.id, discussionId: discussion!.id };
  }

  interface ExportBody {
    filename: string;
    markdown: string;
  }

  async function exportDiscussion(id: string, cookies: CookieRecord[]) {
    currentCookies = cookies;
    return GET(makeRequest(id));
  }

  test("renders every turn of the discussion, oldest first", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Classical mechanics",
      "Simple pendulum",
    );

    // Inserted newest-first with explicit timestamps, so the route's own
    // ordering is exercised rather than insertion order happening to be
    // right.
    const { error: insertError } = await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "And the equation of motion?",
        response: "Euler-Lagrange gives it.",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-07T00:02:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "What is the Lagrangian?",
        response: "It is T minus V.",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-07T00:01:00Z",
      },
    ]);
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    expect(response.status).toBe(200);
    const { markdown, filename } = (await response.json()) as ExportBody;

    expect(markdown).toContain("# Simple pendulum");
    expect(markdown).toContain("From notebook **Classical mechanics**");
    expect(markdown.match(/^## Turn \d+$/gm)).toEqual([
      "## Turn 1",
      "## Turn 2",
    ]);
    expect(markdown.indexOf("What is the Lagrangian?")).toBeLessThan(
      markdown.indexOf("And the equation of motion?"),
    );
    expect(filename).toMatch(/^Simple-pendulum-\d{4}-\d{2}-\d{2}\.md$/);
  });

  // The isolation check task 62 needed, in the other direction: a file
  // the user believes holds one conversation must not carry a sibling's.
  test("a sibling discussion in the same notebook does not leak in", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { notebookId, discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Shared notebook",
      "The one being exported",
    );

    const { data: sibling, error: siblingError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebookId,
        user_id: userId,
        name: "The sibling",
      })
      .select()
      .single();
    expect(siblingError).toBeNull();

    const { error: insertError } = await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "mine",
        response: "belongs in the export",
        resolved_model: "claude-sonnet-4-6",
      },
      {
        discussion_id: sibling!.id,
        user_id: userId,
        prompt_text: "theirs",
        response: "SIBLING CONTENT MUST NOT APPEAR",
        resolved_model: "claude-sonnet-4-6",
      },
    ]);
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    const { markdown } = (await response.json()) as ExportBody;

    expect(markdown).toContain("belongs in the export");
    expect(markdown).not.toContain("SIBLING CONTENT MUST NOT APPEAR");
    expect(markdown).not.toContain("theirs");
    expect(markdown.match(/^## Turn \d+$/gm)).toEqual(["## Turn 1"]);
  });

  test("an in-flight turn is marked, not rendered as an empty response", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Notebook",
      "Half-finished",
    );

    const { error: insertError } = await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "answered one",
        response: "here is the answer",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-07T00:01:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "still running one",
        response: null,
        created_at: "2026-09-07T00:02:00Z",
      },
    ]);
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    const { markdown } = (await response.json()) as ExportBody;

    expect(markdown).toContain("still running one");
    expect(markdown).toContain(
      "_No response recorded — this turn did not complete._",
    );
    expect(markdown).toContain("here is the answer");
  });

  test("markdown in a response reaches the file unmangled", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Notebook",
      "Formatted",
    );

    const rich = [
      "## A heading",
      "",
      "- one",
      "- two",
      "",
      "```python",
      "def f(x):",
      "    return x ** 2",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");

    const { error: insertError } = await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userId,
      prompt_text: "format things",
      response: rich,
      resolved_model: "claude-sonnet-4-6",
    });
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    const { markdown } = (await response.json()) as ExportBody;
    expect(markdown).toContain(rich);
  });

  // prompt_content is the rich document the user typed; prompt_text is
  // the flattened copy. Exporting the flattened one would quietly drop
  // formatting the app itself shows.
  test("a rich prompt exports with its formatting, not the flattened text", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Notebook",
      "Rich prompt",
    );

    const { error: insertError } = await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userId,
      prompt_text: "Compare energy and momentum.",
      prompt_content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Compare " },
              { type: "text", text: "energy", marks: [{ type: "bold" }] },
              { type: "text", text: " and momentum." },
            ],
          },
        ],
      },
      response: "Both are conserved.",
      resolved_model: "claude-sonnet-4-6",
    });
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    const { markdown } = (await response.json()) as ExportBody;
    expect(markdown).toContain("Compare **energy** and momentum.");
  });

  test("nothing internal reaches the file", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Notebook",
      "Clean",
    );

    const { error: insertError } = await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userId,
      prompt_text: "hello",
      response: "hi",
      model: "claude",
      resolved_model: "claude-sonnet-4-6",
    });
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, cookies);
    const { markdown } = (await response.json()) as ExportBody;

    expect(markdown).not.toContain(discussionId);
    expect(markdown).not.toContain("claude-sonnet-4-6");
    expect(markdown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test("a discussion with no turns still exports a readable file", async () => {
    const { userId, cookies } = await createSignedInUser();
    const { discussionId } = await seedNotebookAndDiscussion(
      userId,
      "Notebook",
      "Nothing here yet",
    );

    const response = await exportDiscussion(discussionId, cookies);
    expect(response.status).toBe(200);
    const { markdown } = (await response.json()) as ExportBody;
    expect(markdown).toContain("# Nothing here yet");
    expect(markdown).toContain("_This discussion has no turns yet._");
  });

  test("another user's discussion is a 404, not their conversation", async () => {
    const userA = await createSignedInUser();
    const userB = await createSignedInUser();

    const { discussionId } = await seedNotebookAndDiscussion(
      userA.userId,
      "User A's notebook",
      "User A's discussion",
    );
    const { error: insertError } = await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userA.userId,
      prompt_text: "private",
      response: "USER A SECRET",
      resolved_model: "claude-sonnet-4-6",
    });
    expect(insertError).toBeNull();

    const response = await exportDiscussion(discussionId, userB.cookies);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("USER A SECRET");
  });

  test("no id is a 400", async () => {
    const { cookies } = await createSignedInUser();
    currentCookies = cookies;
    const response = await GET(
      new Request("http://localhost/api/discussions/export"),
    );
    expect(response.status).toBe(400);
  });

  test("no session is a 401", async () => {
    currentCookies = [];
    const response = await GET(
      new Request("http://localhost/api/discussions/export?id=whatever"),
    );
    expect(response.status).toBe(401);
  });
});
