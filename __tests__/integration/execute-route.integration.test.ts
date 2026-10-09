import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { encryptSecret } from "@/lib/apiKeyCrypto";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import {
  createAnthropicStreamHandler,
  mockAnthropicStreamedModel,
  mockAnthropicStreamedText,
} from "../mocks/handlers";
import { plainTextToDoc } from "@/lib/richContent";

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

// The per-user key these tests store and expect the route to use. Fake;
// the Anthropic call itself is intercepted by MSW.
const STORED_USER_KEY = "sk-ant-test-stored-user-key-do-not-use";

const { POST } = await import("@/app/api/execute/route");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Minimal SSE stream for tests that only care about what request body was
// sent to Anthropic, not about incremental delta timing (unlike
// createAnthropicStreamHandler's multi-word, optionally-delayed stream).
function buildTinySseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    {
      type: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_tiny",
          type: "message",
          role: "assistant",
          model: mockAnthropicStreamedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      type: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { type: "message_stop", data: { type: "message_stop" } },
  ];

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

describe("POST /api/execute", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;
  let userId: string;
  let notebookId: string;
  let discussionId: string;
  const email = `execute-route-${Date.now()}@example.com`;
  const password = "correct horse battery staple 1!";

  beforeAll(async () => {
    // Full reset so this file's run starts from a known-clean local DB,
    // same as the other integration test — files run sequentially
    // (fileParallelism: false in vitest.integration.config.mts) so the two
    // resets can't race each other.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // Unlike the hosted project, the local CLI-provisioned Postgres does not
    // auto-grant anon/authenticated/service_role access to new tables (no
    // `auto_expose_new_tables`, see supabase/config.toml) — the hosted
    // project's grants were confirmed already present via
    // `supabase db query --linked`. This mirrors the existing probe-table
    // integration test's own local-only GRANT and touches no migration file.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks, " +
        "public.discussions, public.responses, public.execution_locks " +
        "TO anon, authenticated, service_role;",
    );
    // Functions aren't auto-exposed locally either (same config.toml note
    // above covers "tables, views, sequences and functions").
    runLocalSql(
      "GRANT EXECUTE ON FUNCTION public.try_acquire_execution_lock" +
        "(uuid, uuid, interval) TO anon, authenticated, service_role;",
    );
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;

    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    // Task 51 made /api/execute use the CALLING USER'S stored key rather
    // than this environment variable, so the route no longer reads it.
    // Kept only because assertions below check it never leaks.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-do-not-use";
    // Local-only, and only has to be a valid 32-byte base64 value --
    // nothing here decrypts against a real deployment.
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString(
      "base64",
    );

    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw createError ?? new Error("failed to create test user");
    }
    userId = created.user.id;

    // Task 51: every run now requires the user's OWN stored Anthropic
    // key. Seeded encrypted, exactly as the Keys tab would write it, so
    // these tests exercise the real decrypt path rather than bypassing
    // it. Without this every test here gets a 400 asking the user to add
    // a key -- which is how this file silently broke.
    const { error: keyError } = await admin.from("user_api_keys").upsert({
      user_id: userId,
      anthropic_key_encrypted: encryptSecret(STORED_USER_KEY),
    });
    if (keyError) throw keyError;

    // No discussion-creation endpoint exists yet, so seed directly.
    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Execute route test notebook" })
      .select()
      .single();
    if (notebookError || !notebook) {
      throw notebookError ?? new Error("failed to seed notebook");
    }
    notebookId = notebook.id;

    const { data: discussion, error: discussionError } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook.id,
        user_id: userId,
        name: "Execute route test discussion",
      })
      .select()
      .single();
    if (discussionError || !discussion) {
      throw discussionError ?? new Error("failed to seed discussion");
    }
    discussionId = discussion.id;

    // Unlike the MSW unit-test harness, this file also talks to the real
    // local Supabase instance (auth, PostgREST) — only the Anthropic call
    // is mocked, so unhandled requests must pass through, not error.
    server.listen({ onUnhandledRequest: "bypass" });
  }, 60000);

  beforeEach(() => {
    // The route always requests `stream: true` now, so every test needs
    // the SSE-shaped mock by default; a test that needs something else
    // (e.g. the 409 test's call-tracking override) layers its own
    // server.use() on top, which takes priority for that test.
    server.use(createAnthropicStreamHandler());
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  async function signInAsTestUser(): Promise<CookieRecord[]> {
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

    const { error } = await jarClient.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;

    return cookies;
  }

  test("returns 401 when there is no authenticated user", async () => {
    currentCookies = [];

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
    );

    expect(response.status).toBe(401);
  });

  test("returns 409 and does not call the model when a lock is already held", async () => {
    currentCookies = await signInAsTestUser();

    const { error: lockError } = await admin
      .from("execution_locks")
      .insert({ user_id: userId, discussion_id: discussionId });
    expect(lockError).toBeNull();

    let modelCalled = false;
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        modelCalled = true;
        return HttpResponse.json({});
      }),
    );

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
    );

    expect(response.status).toBe(409);
    expect(modelCalled).toBe(false);

    await admin.from("execution_locks").delete().eq("user_id", userId);
  });

  test("reclaims a stale lock and allows execution to proceed", async () => {
    currentCookies = await signInAsTestUser();

    const { error: lockError } = await admin
      .from("execution_locks")
      .insert({ user_id: userId, discussion_id: discussionId });
    expect(lockError).toBeNull();

    // Backdate the lock past the function's 5-minute staleness threshold,
    // simulating a crashed invocation that never released it.
    const staleAcquiredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error: backdateError } = await admin
      .from("execution_locks")
      .update({ acquired_at: staleAcquiredAt })
      .eq("user_id", userId);
    expect(backdateError).toBeNull();

    const promptText = `stale-reclaim-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolved_model).toBe(mockAnthropicStreamedModel);
    expect(body.response).toBe(mockAnthropicStreamedText);

    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  // Retargeted (task 55b). This used to delete ANTHROPIC_API_KEY and
  // expect a 500, which was correct while one shared environment key
  // served every run. Task 51 replaced that with per-user stored keys,
  // so the equivalent failure is now "this user has not saved one" --
  // and the right answer is an actionable 400, not a server error.
  //
  // The invariant worth keeping is unchanged and still asserted: a run
  // that cannot proceed must not touch the execution lock.
  test("returns 400 with the blocking message, and touches no lock, when the user has no stored key", async () => {
    currentCookies = await signInAsTestUser();

    const { error: deleteError } = await admin
      .from("user_api_keys")
      .delete()
      .eq("user_id", userId);
    expect(deleteError).toBeNull();

    try {
      const response = await POST(
        makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
      );
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.code).toBe("missing_anthropic_key");
      expect(body.error).toMatch(/Account/);

      const { data: lockRows, error: lockCheckError } = await admin
        .from("execution_locks")
        .select("*")
        .eq("user_id", userId);
      expect(lockCheckError).toBeNull();
      expect(lockRows).toHaveLength(0);
    } finally {
      const { error: restoreError } = await admin.from("user_api_keys").upsert({
        user_id: userId,
        anthropic_key_encrypted: encryptSecret(STORED_USER_KEY),
      });
      expect(restoreError).toBeNull();
    }
  });

  // The production outage of 2026-09-27. A stored key that cannot be
  // decrypted made /api/execute throw from getUserAnthropicKey, which
  // sits BEFORE the handler's own try/catch, so withRouteErrorHandling
  // turned it into a bare "Internal server error." -- no error id, no
  // remedy, and indistinguishable from a crash. The trigger in
  // production was API_KEY_ENCRYPTION_SECRET never having been set in
  // Vercel, but any secret rotation reproduces it.
  //
  // Both halves are asserted, because they need different messages: the
  // server having no usable secret is nobody-but-the-operator's problem,
  // while a row encrypted under a different secret is fixed by the user
  // re-saving their key.
  test("returns an actionable 503, not a bare 500, when the server has no usable encryption secret", async () => {
    currentCookies = await signInAsTestUser();
    const secret = process.env.API_KEY_ENCRYPTION_SECRET;
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    try {
      const response = await POST(
        makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
      );
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body.code).toBe("key_encryption_unconfigured");
      expect(body.error).not.toMatch(/internal server error/i);
      // It must say the run never reached Anthropic -- the first thing
      // anyone wonders about a failed run is whether it was billed.
      expect(body.error).toMatch(/nothing was sent to anthropic/i);
      // And it must never name the secret's value, only the situation.
      expect(body.error).not.toMatch(/API_KEY_ENCRYPTION_SECRET/);

      const { data: lockRows } = await admin
        .from("execution_locks")
        .select("*")
        .eq("user_id", userId);
      expect(lockRows).toHaveLength(0);
    } finally {
      process.env.API_KEY_ENCRYPTION_SECRET = secret;
    }
  });

  test("returns an actionable 400, not a bare 500, when the stored key was encrypted under a different secret", async () => {
    currentCookies = await signInAsTestUser();
    const secret = process.env.API_KEY_ENCRYPTION_SECRET;
    // A different, valid secret: the row is intact, just unreadable.
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 4).toString(
      "base64",
    );
    try {
      const response = await POST(
        makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
      );
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.code).toBe("unreadable_anthropic_key");
      expect(body.error).not.toMatch(/internal server error/i);
      expect(body.error).toMatch(/Account/);

      const { data: lockRows } = await admin
        .from("execution_locks")
        .select("*")
        .eq("user_id", userId);
      expect(lockRows).toHaveLength(0);
    } finally {
      process.env.API_KEY_ENCRYPTION_SECRET = secret;
    }
  });

  // Task 58. A well-formed key that Anthropic itself refuses -- revoked,
  // mistyped, or another account's. This is the case a real user is most
  // likely to hit, and it used to produce the least useful of the four
  // key messages: the generic "contact support", which points at us when
  // the remedy is entirely theirs.
  //
  // Distinct from the incident fix: that one handles a key that is
  // missing or cannot be decrypted, i.e. detectable before any request
  // is made. This one reads fine and reaches Anthropic.
  test("a key Anthropic rejects with 401 produces an actionable message, not the generic failure", async () => {
    currentCookies = await signInAsTestUser();

    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "API key is invalid.",
            },
          },
          { status: 401 },
        ),
      ),
    );

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("anthropic_rejected_key");
    expect(body.error).toMatch(/Anthropic rejected your API key/i);
    expect(body.error).toMatch(/Account/);
    // The old behaviour, explicitly excluded.
    expect(body.error).not.toMatch(/contact support/i);
    // No error id: this needs no support round trip, and an opaque id
    // would make an actionable message read as a crash report.
    expect(body.errorId).toBeUndefined();
    // Anthropic's own wording must not leak through.
    expect(body.error).not.toMatch(/authentication_error/);

    // 400, not 401 -- this route uses 401 for "no session", and the two
    // must stay distinguishable to any caller reading the status.
    expect(response.status).not.toBe(401);
  });

  // The other half of the requirement: the 401 branch must not swallow
  // unrelated failures. A 500 from Anthropic is a genuine execution
  // failure and must keep its generic message AND its error id.
  test("a non-401 Anthropic failure still returns the generic message with an error id", async () => {
    currentCookies = await signInAsTestUser();

    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json(
          {
            type: "error",
            error: { type: "api_error", message: "Overloaded" },
          },
          { status: 500 },
        ),
      ),
    );

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/Execution failed/i);
    expect(body.errorId).toEqual(expect.any(String));
    expect(body.code).toBeUndefined();
    expect(body.error).not.toMatch(/Anthropic rejected/i);
  });

  // 403 is deliberately NOT treated as a key rejection: it is an account
  // or permission problem, and telling the user to re-check a valid key
  // would send them to fix the one thing that is not broken.
  test("a 403 is not misreported as a rejected key", async () => {
    currentCookies = await signInAsTestUser();

    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json(
          {
            type: "error",
            error: { type: "permission_error", message: "nope" },
          },
          { status: 403 },
        ),
      ),
    );

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("hello") }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toMatch(/Anthropic rejected/i);
    expect(body.errorId).toEqual(expect.any(String));
  });

  // Task 62. The discussion's own prior turns.
  //
  // Asserted on the OUTBOUND REQUEST, not the visible reply: a model
  // can answer a follow-up plausibly without ever having been sent the
  // earlier turn, so checking the response would hide exactly the bug
  // being fixed.
  test("a later turn sends this discussion's prior turns, in order, with alternating roles", async () => {
    currentCookies = await signInAsTestUser();

    // Start from a known-empty discussion. Earlier tests in this file
    // share discussionId and leave response rows behind -- harmless
    // until task 62, because history was never read. Now that it is,
    // those rows would join this request, so each history test owns
    // its own starting state.
    await admin.from("responses").delete().eq("discussion_id", discussionId);

    // Two completed turns already in this discussion.
    await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "Who was Nikola Tesla?",
        response: "An inventor. Pioneered early wireless communication.",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:00:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "What about alternating current?",
        response: "He championed AC over DC.",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:05:00Z",
      },
    ]);

    let sent: { role: string; content: unknown }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string; content: unknown }[];
          };
          sent = body.messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const response = await POST(
      makeRequest({
        discussionId,
        promptContent: plainTextToDoc("In your first response you wrote..."),
      }),
    );
    expect(response.status).toBe(200);

    // Two prior turns -> four messages, then the new prompt.
    expect(sent).toHaveLength(5);
    expect(sent.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(sent[0].content).toBe("Who was Nikola Tesla?");
    expect(sent[1].content).toBe(
      "An inventor. Pioneered early wireless communication.",
    );
    expect(sent[2].content).toBe("What about alternating current?");
    expect(sent[3].content).toBe("He championed AC over DC.");
    // The current prompt is last, and is rich content rather than text.
    expect(Array.isArray(sent[4].content)).toBe(true);

    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  // Task 69. Earlier turns' images are carried forward, fetched from the
  // real local prompt-images bucket through the user's own session (RLS),
  // exactly as the current turn's are.
  test("a later turn carries every earlier image, in order, from real storage", async () => {
    currentCookies = await signInAsTestUser();
    await admin.from("responses").delete().eq("discussion_id", discussionId);

    const shot1 = Buffer.from("first-screenshot-bytes");
    const shot2 = Buffer.from("second-screenshot-bytes");
    const path1 = `${userId}/${discussionId}/history-1-${Date.now()}.png`;
    const path2 = `${userId}/${discussionId}/history-2-${Date.now()}.jpg`;
    for (const [path, bytes, type] of [
      [path1, shot1, "image/png"],
      [path2, shot2, "image/jpeg"],
    ] as const) {
      const { error } = await admin.storage
        .from("prompt-images")
        .upload(path, bytes, { contentType: type });
      expect(error).toBeNull();
    }
    const doc = (text: string, path: string) => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text }] },
        {
          type: "image",
          attrs: { src: `/api/prompt-images/${path}`, alt: "shot" },
        },
      ],
    });

    await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "Here is my first screenshot.",
        prompt_content: doc("Here is my first screenshot.", path1),
        response: "I see the first one.",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:00:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "No picture this time.",
        response: "Understood.",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:02:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "And a second screenshot.",
        prompt_content: doc("And a second screenshot.", path2),
        response: "I see the second one.",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:05:00Z",
      },
    ]);

    let sent: { role: string; content: unknown }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string; content: unknown }[];
          };
          sent = body.messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const response = await POST(
      makeRequest({
        discussionId,
        promptContent: plainTextToDoc("Compare the two screenshots."),
      }),
    );
    expect(response.status).toBe(200);

    expect(sent.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // Same block shape the current turn uses.
    expect(sent[0].content).toEqual([
      { type: "text", text: "Here is my first screenshot." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: shot1.toString("base64"),
        },
      },
    ]);
    // A text-only turn is still a plain string, as in Task 62.
    expect(sent[2].content).toBe("No picture this time.");
    expect(sent[4].content).toEqual([
      { type: "text", text: "And a second screenshot." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: shot2.toString("base64"),
        },
      },
    ]);
    expect(sent[6].content).toEqual([
      { type: "text", text: "Compare the two screenshots." },
    ]);

    await admin.from("responses").delete().eq("discussion_id", discussionId);
    await admin.storage.from("prompt-images").remove([path1, path2]);
  });

  test("an earlier image that is gone from storage does not stop the run", async () => {
    currentCookies = await signInAsTestUser();
    await admin.from("responses").delete().eq("discussion_id", discussionId);
    await admin.from("responses").insert({
      discussion_id: discussionId,
      user_id: userId,
      prompt_text: "A picture that was later lost.",
      prompt_content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "A picture that was later lost." }],
          },
          {
            type: "image",
            attrs: {
              src: `/api/prompt-images/${userId}/${discussionId}/never-uploaded.png`,
            },
          },
        ],
      },
      response: "Noted.",
      model: "m",
      resolved_model: "claude-sonnet-4-6",
      created_at: "2026-09-01T10:00:00Z",
    });

    let sent: { role: string; content: unknown }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          sent = ((await request.json()) as { messages: typeof sent }).messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );
    const response = await POST(
      makeRequest({
        discussionId,
        promptContent: plainTextToDoc("Still there?"),
      }),
    );
    expect(response.status).toBe(200);
    expect(sent[0].content).toEqual([
      { type: "text", text: "A picture that was later lost." },
      {
        type: "text",
        text: "[An image was attached here, but it is no longer stored.]",
      },
    ]);
    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  // ---- Task 71: the history cap ----

  function captureAnthropic(replies: (() => Response)[] = []): {
    calls: { role: string; content: unknown }[][];
  } {
    const calls: { role: string; content: unknown }[][] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string; content: unknown }[];
          };
          calls.push(body.messages);
          const reply = replies[calls.length - 1];
          if (reply) return reply();
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );
    return { calls };
  }

  async function seedTurns(
    turns: { prompt: string; response: string; images?: number }[],
  ) {
    await admin.from("responses").delete().eq("discussion_id", discussionId);
    const { error } = await admin.from("responses").insert(
      turns.map((t, i) => ({
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: t.prompt,
        prompt_content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: t.prompt }] },
            ...Array.from({ length: t.images ?? 0 }, (_, j) => ({
              type: "image",
              attrs: {
                src: `/api/prompt-images/${userId}/${discussionId}/cap-${i}-${j}.png`,
              },
            })),
          ],
        },
        response: t.response,
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
      })),
    );
    expect(error).toBeNull();
  }

  const firstText = (m: { content: unknown }) =>
    typeof m.content === "string"
      ? m.content
      : (m.content as { type: string; text?: string }[])[0]?.text;

  test("a discussion too long for the model's window drops its oldest whole turns, and keeps everything stored and exported", async () => {
    currentCookies = await signInAsTestUser();
    // Eight turns of about 22,000 estimated tokens each -- far more than
    // the room left with max_tokens at 40,000.
    const turns = Array.from({ length: 8 }, (_, i) => ({
      prompt: `TURN-${i} ` + "p".repeat(33_000),
      response: `ANSWER-${i} ` + "r".repeat(33_000),
    }));
    await seedTurns(turns);
    const { calls } = captureAnthropic();

    const response = await POST(
      makeRequest({
        discussionId,
        promptContent: plainTextToDoc("What did we conclude last?"),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    const keptTurns = (sent.length - 1) / 2;
    expect(keptTurns).toBeGreaterThan(0);
    expect(keptTurns).toBeLessThan(8);
    expect(body.history_turns_left_out).toBe(8 - keptTurns);
    expect(body.history_turns_sent).toBe(keptTurns);

    // The newest turns, in order, whole, ending right before the question.
    const expectedFirst = 8 - keptTurns;
    for (let k = 0; k < keptTurns; k++) {
      expect(sent[2 * k].role).toBe("user");
      expect(sent[2 * k].content).toBe(turns[expectedFirst + k].prompt);
      expect(sent[2 * k + 1].role).toBe("assistant");
      expect(sent[2 * k + 1].content).toBe(turns[expectedFirst + k].response);
    }
    expect(sent[sent.length - 1].role).toBe("user");

    // Nothing was removed from storage...
    const { data: stored } = await admin
      .from("responses")
      .select("id")
      .eq("discussion_id", discussionId);
    expect(stored).toHaveLength(8 + 1);

    // ...or from either export.
    const { GET: exportNotebook } =
      await import("@/app/api/notebooks/export/route");
    const pact = await (
      await exportNotebook(
        new Request(`http://localhost/api/notebooks/export?id=${notebookId}`),
      )
    ).json();
    const pactCells = (pact.cells as { discussionId: string }[]).filter(
      (c) => c.discussionId === discussionId,
    );
    expect(pactCells).toHaveLength(9);

    const { GET: exportDiscussion } =
      await import("@/app/api/discussions/export/route");
    const md = await (
      await exportDiscussion(
        new Request(
          `http://localhost/api/discussions/export?id=${discussionId}`,
        ),
      )
    ).json();
    for (let i = 0; i < 8; i++) expect(md.markdown).toContain(`TURN-${i} `);

    await admin.from("responses").delete().eq("discussion_id", discussionId);
  }, 60_000);

  test("pictures are counted: three picture turns fill a budget that the same turns without pictures do not", async () => {
    currentCookies = await signInAsTestUser();
    // Leaves roughly 5,000 tokens for history: room for three turns with
    // one picture each (about 1,630 tokens apiece), not four.
    await admin
      .from("app_settings")
      .update({ max_tokens: 175_000 })
      .eq("id", 1);
    try {
      await seedTurns(
        ["a", "b", "c", "d"].map((p) => ({
          prompt: p,
          response: "ok",
          images: 1,
        })),
      );
      const withPictures = captureAnthropic();
      const r1 = await POST(
        makeRequest({ discussionId, promptContent: plainTextToDoc("q") }),
      );
      expect(r1.status).toBe(200);
      expect((await r1.json()).history_turns_left_out).toBe(1);
      const sent = withPictures.calls[0];
      expect(sent).toHaveLength(7);
      expect(
        sent
          .filter((m) => m.role === "user")
          .slice(0, 3)
          .map(firstText),
      ).toEqual(["b", "c", "d"]);

      await seedTurns(
        ["a", "b", "c", "d"].map((p) => ({ prompt: p, response: "ok" })),
      );
      const withoutPictures = captureAnthropic();
      const r2 = await POST(
        makeRequest({ discussionId, promptContent: plainTextToDoc("q") }),
      );
      expect((await r2.json()).history_turns_left_out).toBe(0);
      expect(withoutPictures.calls[0]).toHaveLength(9);
    } finally {
      await admin
        .from("app_settings")
        .update({ max_tokens: 40000 })
        .eq("id", 1);
      await admin.from("responses").delete().eq("discussion_id", discussionId);
    }
  });

  test("if Anthropic still says the prompt is too long, older turns are dropped and it is sent once more", async () => {
    currentCookies = await signInAsTestUser();
    await seedTurns(
      Array.from({ length: 6 }, (_, i) => ({
        prompt: `T${i} ` + "x".repeat(3_000),
        response: "y".repeat(3_000),
      })),
    );
    const { calls } = captureAnthropic([
      () =>
        HttpResponse.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              // The first budget is 180,000 - 40,000 - 10 = 139,990; this
              // overshoot (124,990) less a 10,000 cushion leaves 5,000,
              // room for the two newest turns (about 2,017 each).
              message: "prompt is too long: 324990 tokens > 200000 maximum",
            },
          },
          { status: 400 },
        ),
    ]);
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("again") }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(13);
    expect(calls[1]).toHaveLength(5);
    // Still the newest turns, whole.
    expect(firstText(calls[1][calls[1].length - 3])).toBe(
      `T5 ` + "x".repeat(3_000),
    );
    expect((await response.json()).history_turns_left_out).toBe(
      6 - (calls[1].length - 1) / 2,
    );
    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  test("any other 400 is not retried", async () => {
    currentCookies = await signInAsTestUser();
    await seedTurns([{ prompt: "one", response: "1" }]);
    const { calls } = captureAnthropic([
      () =>
        HttpResponse.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "bad request" },
          },
          { status: 400 },
        ),
    ]);
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("x") }),
    );
    expect(response.status).not.toBe(200);
    expect(calls).toHaveLength(1);
    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  test("a short discussion is sent whole, with nothing left out", async () => {
    currentCookies = await signInAsTestUser();
    await seedTurns([
      { prompt: "one", response: "1" },
      { prompt: "two", response: "2" },
    ]);
    const { calls } = captureAnthropic();
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("three") }),
    );
    const body = await response.json();
    expect(body.history_turns_left_out).toBe(0);
    expect(body.history_turns_sent).toBe(2);
    expect(calls[0].map((m) => m.content).slice(0, 4)).toEqual([
      "one",
      "1",
      "two",
      "2",
    ]);
    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  test("a brand-new discussion's first turn still sends exactly one message", async () => {
    currentCookies = await signInAsTestUser();

    const { data: fresh } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebookId,
        user_id: userId,
        name: `history-first-turn-${Date.now()}`,
      })
      .select()
      .single();

    let sent: { role: string }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string }[];
          };
          sent = body.messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const response = await POST(
      makeRequest({
        discussionId: fresh!.id,
        promptContent: plainTextToDoc("first ever prompt"),
      }),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].role).toBe("user");
  });

  // The leak the brief asked about: two discussions in ONE notebook.
  test("a sibling discussion's turns never leak into this one", async () => {
    currentCookies = await signInAsTestUser();
    await admin.from("responses").delete().eq("discussion_id", discussionId);

    const { data: sibling } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebookId,
        user_id: userId,
        name: `history-sibling-${Date.now()}`,
      })
      .select()
      .single();

    await admin.from("responses").insert({
      discussion_id: sibling!.id,
      user_id: userId,
      prompt_text: "SIBLING SECRET PROMPT",
      response: "SIBLING SECRET RESPONSE",
      model: "m",
      resolved_model: "claude-sonnet-4-6",
    });

    let sent: { role: string; content: unknown }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string; content: unknown }[];
          };
          sent = body.messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const response = await POST(
      makeRequest({
        discussionId,
        promptContent: plainTextToDoc("unrelated prompt"),
      }),
    );
    expect(response.status).toBe(200);

    const asText = JSON.stringify(sent);
    expect(asText).not.toContain("SIBLING SECRET PROMPT");
    expect(asText).not.toContain("SIBLING SECRET RESPONSE");
    expect(sent).toHaveLength(1);
  });

  // An in-flight or failed run leaves a row with no response. Including
  // its prompt would put two user messages back to back, which
  // Anthropic rejects -- so one failed run would break every later turn
  // in that discussion.
  test("an incomplete prior turn is dropped rather than breaking role alternation", async () => {
    currentCookies = await signInAsTestUser();
    await admin.from("responses").delete().eq("discussion_id", discussionId);

    await admin.from("responses").insert([
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "a completed turn",
        response: "its answer",
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:00:00Z",
      },
      {
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: "a run that never finished",
        response: null,
        model: "m",
        resolved_model: "claude-sonnet-4-6",
        created_at: "2026-09-01T10:05:00Z",
      },
    ]);

    let sent: { role: string; content: unknown }[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as {
            messages: { role: string; content: unknown }[];
          };
          sent = body.messages;
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("next") }),
    );
    expect(response.status).toBe(200);

    // The completed pair, then the new prompt. The dangling one is gone.
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sent)).not.toContain("a run that never finished");

    // No two consecutive user messages anywhere.
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role === sent[i - 1].role).toBe(false);
    }

    await admin.from("responses").delete().eq("discussion_id", discussionId);
  });

  // Task 55b part 1.
  test("accumulates each run's total_ms into discussions.total_time_ms", async () => {
    currentCookies = await signInAsTestUser();

    const readTotal = async () => {
      const { data, error } = await admin
        .from("discussions")
        .select("total_time_ms")
        .eq("id", discussionId)
        .single();
      expect(error).toBeNull();
      return data!.total_time_ms as number;
    };

    // Starts at the column's default. Before this task nothing ever
    // wrote it, so it stayed here forever.
    const before = await readTotal();

    const first = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("run one") }),
    );
    expect(first.status).toBe(200);
    const afterFirst = await readTotal();
    expect(afterFirst).toBeGreaterThan(before);

    // ACCUMULATES rather than overwrites -- the column is a running
    // total for the discussion, not the last run's duration.
    const second = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("run two") }),
    );
    expect(second.status).toBe(200);
    const afterSecond = await readTotal();
    expect(afterSecond).toBeGreaterThan(afterFirst);

    // And it equals what execution_timings recorded, rather than
    // drifting off on its own.
    //
    // Compared as absolute totals, not as a delta across these two
    // runs: earlier tests in this file execute against the same
    // discussion, so `before` already includes their time while the
    // timing rows include it too. Both accumulate from zero, so the
    // totals must match exactly -- a stronger check than the delta, and
    // one that does not depend on test order.
    const { data: timingRows, error: timingError } = await admin
      .from("execution_timings")
      .select("total_ms")
      .eq("discussion_id", discussionId);
    expect(timingError).toBeNull();
    const timingSum = (timingRows ?? []).reduce(
      (sum, r) => sum + (r.total_ms ?? 0),
      0,
    );
    expect(afterSecond).toBe(timingSum);
  });

  test("returns 400 for a malformed request body", async () => {
    currentCookies = await signInAsTestUser();

    const response = await POST(
      new Request("http://localhost/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json{{{",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test("returns 400, and never acquires the lock, for an empty or whitespace-only promptContent", async () => {
    currentCookies = await signInAsTestUser();

    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc("   ") }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();

    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  test("on success, inserts a responses row, releases the lock, and never leaks the API key", async () => {
    currentCookies = await signInAsTestUser();

    const promptText = `probe-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );
    const rawText = await response.text();
    const parsed = JSON.parse(rawText);

    expect(response.status).toBe(200);
    expect(parsed.resolved_model).toBe(mockAnthropicStreamedModel);
    expect(parsed.response).toBe(mockAnthropicStreamedText);
    expect(rawText).not.toContain(process.env.ANTHROPIC_API_KEY);
    // Task 51: the key actually used is the user's stored one, so that
    // is the value that must not leak.
    expect(rawText).not.toContain(STORED_USER_KEY);

    const { data: responseRows, error: responseError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(responseError).toBeNull();
    expect(responseRows).toHaveLength(1);
    expect(responseRows?.[0].resolved_model).toBe(mockAnthropicStreamedModel);
    expect(responseRows?.[0].response).toBe(mockAnthropicStreamedText);

    // Persistence audit finding A: the client needs the real row id to
    // append this run directly into its own in-memory history, instead
    // of only learning about it via a future, unrelated discussion
    // switch's own fetch.
    expect(parsed.response_row_id).toBe(responseRows?.[0].id);

    // Display cleanup: the client shows this timestamp next to
    // "Discussion: {name}" -- must be the row's own database-assigned
    // created_at (set at message_start, near the start of generation),
    // never an approximation of when this request happened to finish.
    expect(parsed.response_created_at).toBe(responseRows?.[0].created_at);

    const { data: lockRows, error: lockError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);

    expect(lockError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });

  test("streams incrementally: the row exists mid-request with partial content before the final write", async () => {
    currentCookies = await signInAsTestUser();

    // A real per-delta delay, unlike every other test in this file (which
    // uses the default 0ms handler for speed) — this is the one test that
    // actually needs wall-clock time to elapse while the request is still
    // in flight, so there's something to observe mid-stream. A test that
    // only checked the final row state would pass identically whether this
    // was truly streamed or written once at the end; this one doesn't.
    // 400ms/word (11 words ≈ 4.4s total) rather than 200ms/word: task 18
    // raised STREAM_WRITE_THROTTLE_MS 500ms -> 2000ms, so the wait below
    // needs comfortable room past 2000ms for a write to have landed while
    // still leaving the stream clearly unfinished, not a photo finish.
    server.use(createAnthropicStreamHandler(400));

    const promptText = `mid-flight-${Date.now()}`;
    const postPromise = POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );

    // message_start arrives near-instantly (the row gets created almost
    // immediately); the throttle (2000ms, task 18) should have let one
    // delta write land by 2500ms in, while the full stream (11 words *
    // 400ms ≈ 4.4s) is still well short of message_stop.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const { data: midFlightRows, error: midFlightError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(midFlightError).toBeNull();
    expect(midFlightRows).toHaveLength(1);
    const midFlightRow = midFlightRows![0];

    expect(midFlightRow.resolved_model).toBe(mockAnthropicStreamedModel);
    // The actual proof this is incremental: content already exists, but
    // it's a strict, non-final prefix of the eventual complete text — not
    // null (nothing written yet) and not the full text (written once at
    // the end).
    expect(midFlightRow.response).not.toBeNull();
    expect(midFlightRow.response.length).toBeGreaterThan(0);
    expect(midFlightRow.response).not.toBe(mockAnthropicStreamedText);
    expect(mockAnthropicStreamedText.startsWith(midFlightRow.response)).toBe(
      true,
    );

    const response = await postPromise;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.response).toBe(mockAnthropicStreamedText);

    const { data: finalRows, error: finalError } = await admin
      .from("responses")
      .select("*")
      .eq("discussion_id", discussionId)
      .eq("prompt_text", promptText);

    expect(finalError).toBeNull();
    expect(finalRows).toHaveLength(1);
    // Same row throughout, not a duplicate created at completion.
    expect(finalRows![0].id).toBe(midFlightRow.id);
    expect(finalRows![0].response).toBe(mockAnthropicStreamedText);

    const { data: lockRowsAfter, error: lockErrorAfter } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockErrorAfter).toBeNull();
    expect(lockRowsAfter).toHaveLength(0);
  });

  test("uses the configured app_settings.max_tokens value, not a hardcoded one", async () => {
    currentCookies = await signInAsTestUser();

    const { error: settingsError } = await admin
      .from("app_settings")
      .update({ max_tokens: 55 })
      .eq("id", 1);
    expect(settingsError).toBeNull();

    let capturedMaxTokens: number | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { max_tokens?: number };
          capturedMaxTokens = body.max_tokens;
          return new HttpResponse(buildTinySseStream("configured"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `configured-max-tokens-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );

    expect(response.status).toBe(200);
    expect(capturedMaxTokens).toBe(55);

    await admin.from("app_settings").update({ max_tokens: 40000 }).eq("id", 1);
  });

  test("falls back to the old hardcoded max_tokens when app_settings has no row", async () => {
    currentCookies = await signInAsTestUser();

    const { error: deleteError } = await admin
      .from("app_settings")
      .delete()
      .eq("id", 1);
    expect(deleteError).toBeNull();

    let capturedMaxTokens: number | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { max_tokens?: number };
          capturedMaxTokens = body.max_tokens;
          return new HttpResponse(buildTinySseStream("fallback"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `fallback-max-tokens-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );

    expect(response.status).toBe(200);
    expect(capturedMaxTokens).toBe(1000);

    await admin.from("app_settings").insert({ id: 1, max_tokens: 40000 });
  });

  test("sends the active discussion's notebook system_prompt as Anthropic's system parameter", async () => {
    currentCookies = await signInAsTestUser();

    const { error: notebookUpdateError } = await admin
      .from("notebooks")
      .update({ system_prompt: "Always respond in French." })
      .eq("id", notebookId);
    expect(notebookUpdateError).toBeNull();

    let capturedSystem: string | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { system?: string };
          capturedSystem = body.system;
          return new HttpResponse(buildTinySseStream("bonjour"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `system-prompt-sent-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );

    expect(response.status).toBe(200);
    expect(capturedSystem).toBe("Always respond in French.");

    await admin
      .from("notebooks")
      .update({ system_prompt: null })
      .eq("id", notebookId);
  });

  // Task 53's third verification point. The other two were already
  // covered (the test above, and the omit-entirely test below); this
  // one was not, and it is the one that matters once the prompt is
  // editable from two places: a value read once and cached would pass
  // both of those and still be wrong here.
  test("editing a notebook's system_prompt takes effect on the very next run", async () => {
    currentCookies = await signInAsTestUser();

    const captured: (string | undefined)[] = [];
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as { system?: string };
          captured.push(body.system);
          return new HttpResponse(buildTinySseStream("ok"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    try {
      await admin
        .from("notebooks")
        .update({ system_prompt: "First instruction." })
        .eq("id", notebookId);
      const first = await POST(
        makeRequest({
          discussionId,
          promptContent: plainTextToDoc(`edit-takes-effect-1-${Date.now()}`),
        }),
      );
      expect(first.status).toBe(200);

      // Edited between runs, exactly as the Settings dialog does it.
      await admin
        .from("notebooks")
        .update({ system_prompt: "Second instruction, replacing the first." })
        .eq("id", notebookId);
      const second = await POST(
        makeRequest({
          discussionId,
          promptContent: plainTextToDoc(`edit-takes-effect-2-${Date.now()}`),
        }),
      );
      expect(second.status).toBe(200);

      expect(captured).toEqual([
        "First instruction.",
        "Second instruction, replacing the first.",
      ]);

      // And clearing it stops sending one at all, rather than leaving
      // the last value in force.
      await admin
        .from("notebooks")
        .update({ system_prompt: null })
        .eq("id", notebookId);
      const third = await POST(
        makeRequest({
          discussionId,
          promptContent: plainTextToDoc(`edit-takes-effect-3-${Date.now()}`),
        }),
      );
      expect(third.status).toBe(200);
      expect(captured[2]).toBeUndefined();
    } finally {
      await admin
        .from("notebooks")
        .update({ system_prompt: null })
        .eq("id", notebookId);
    }
  });

  test("omits Anthropic's system parameter entirely when the notebook has no system_prompt", async () => {
    currentCookies = await signInAsTestUser();

    // Explicit, not assumed: confirms the notebook is genuinely in the
    // same state every pre-existing notebook is already in today, rather
    // than relying on test order to have left it that way.
    const { error: notebookUpdateError } = await admin
      .from("notebooks")
      .update({ system_prompt: null })
      .eq("id", notebookId);
    expect(notebookUpdateError).toBeNull();

    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return new HttpResponse(buildTinySseStream("no system prompt"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      ),
    );

    const promptText = `no-system-prompt-${Date.now()}`;
    const response = await POST(
      makeRequest({ discussionId, promptContent: plainTextToDoc(promptText) }),
    );

    expect(response.status).toBe(200);
    expect(capturedBody).toBeDefined();
    expect("system" in capturedBody!).toBe(false);
  });

  // Retargeted by task 58, not weakened. This was written when a 401
  // from Anthropic produced the generic 500, and it asserted three
  // things: the real cause is logged in full, none of it leaks to the
  // user, and the lock is still released. All three still hold and are
  // still asserted here. What changed is only the user-facing half --
  // a refused key now gets its own actionable message -- which makes
  // the no-leak assertions MORE important, not less: the message names
  // the key without quoting anything Anthropic said about it.
  test("logs the real Anthropic 401 in full while showing the user only the actionable key message", async () => {
    currentCookies = await signInAsTestUser();

    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        return HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          },
          { status: 401 },
        );
      }),
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let response: Response;
    let body: { error: string; errorId: string };
    let loggedCalls: unknown[][];
    try {
      const promptText = `anthropic-failure-${Date.now()}`;
      response = await POST(
        makeRequest({
          discussionId,
          promptContent: plainTextToDoc(promptText),
        }),
      );
      body = await response.json();
    } finally {
      // Captured before restoring -- mockRestore() also clears the
      // recorded call history (same as mockReset()), so inspecting
      // consoleErrorSpy.mock.calls after restoring would always see zero.
      loggedCalls = [...consoleErrorSpy.mock.calls];
      consoleErrorSpy.mockRestore();
    }

    // User-facing: actionable, and still leaking nothing.
    expect(response!.status).toBe(400);
    expect(body!.error).toBe(
      "Anthropic rejected your API key. Check it in Account → Keys.",
    );
    expect(body!.error).not.toContain("authentication_error");
    expect(body!.error).not.toContain("invalid x-api-key");
    // No correlation id, by design: the other three key failures carry
    // none either, and this one needs no support round trip.
    expect(body!.errorId).toBeUndefined();

    // Server-side: the real cause, in full, tagged with that same id.
    expect(loggedCalls.length).toBeGreaterThan(0);
    const loggedText = loggedCalls
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(loggedText).toContain("[execute-error]");
    // The log line is still tagged with an id even though the response
    // no longer quotes one -- an operator reading logs must still be
    // able to tie the line to a single request.
    expect(loggedText).toMatch(/\[execute-error\] id=\S+/);
    expect(loggedText).toContain("401");
    expect(loggedText).toContain("authentication_error");
    expect(loggedText).toContain("invalid x-api-key");

    // The lock must still be released despite the failure.
    const { data: lockRows, error: lockCheckError } = await admin
      .from("execution_locks")
      .select("*")
      .eq("user_id", userId);
    expect(lockCheckError).toBeNull();
    expect(lockRows).toHaveLength(0);
  });
});
