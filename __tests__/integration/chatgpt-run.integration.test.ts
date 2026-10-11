import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { http, HttpResponse } from "msw";
import { plainTextToDoc } from "@/lib/richContent";
import { decryptSecret } from "@/lib/apiKeyCrypto";
import {
  OPENAI_ATTACHMENT_REFUSED_MESSAGE,
  OPENAI_MISSING_KEY_MESSAGE,
  OPENAI_NO_CREDIT_MESSAGE,
  OPENAI_RATE_LIMITED_MESSAGE,
  OPENAI_REJECTED_KEY_MESSAGE,
} from "@/lib/userOpenAiKey";
import { server } from "../mocks/server";

// Task 81 Stage 2. A run on ChatGPT, through the real route and the real
// local database, with OpenAI itself stood in for by MSW: the key saved
// through the Keys route, the request OpenAI receives, what is stored,
// and every refusal the user can act on. Claude stays the default.

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

const execute = await import("@/app/api/execute/route");
const openaiKey = await import("@/app/api/account/openai-key/route");
const anthropicKey = await import("@/app/api/account/anthropic-key/route");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_KEY = "sk-proj-integration-test-key-do-not-use-1234";
const ANTHROPIC_KEY = "sk-ant-integration-test-key-do-not-use";

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function openAiStream(model: string, pieces: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = [
    {
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    },
    ...pieces.map((content) => ({
      model,
      choices: [{ index: 0, delta: { content } }],
    })),
    { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: "chatcmpl-it", object: "chat.completion.chunk", ...c })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("a run on ChatGPT", () => {
  let admin: SupabaseClient;
  let API_URL: string;
  let ANON_KEY: string;
  const openAiCalls: { auth: string | null; body: Record<string, unknown> }[] =
    [];
  let anthropicCalls = 0;
  let nextOpenAiReply: () => Response = () =>
    openAiStream("gpt-6.1-sol-2026-09-01", ["Hello ", "from ", "ChatGPT."]);

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
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
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 9).toString(
      "base64",
    );
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);

    server.listen({ onUnhandledRequest: "bypass" });
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        openAiCalls.push({
          auth: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return nextOpenAiReply();
      }),
      http.post(ANTHROPIC_URL, () => {
        anthropicCalls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
  }, 120_000);

  afterAll(() => server.close());

  // A signed-in user with a notebook (system prompt set) and a discussion.
  async function user(options: {
    provider?: "openai" | "anthropic";
    tier?: "standard" | "economy";
    openAiKey?: string;
    anthropicKey?: string;
  }) {
    const email = `chatgpt-run-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "chatgpt run password 81!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        ...(options.provider ? { llm_provider: options.provider } : {}),
        ...(options.tier ? { model_tier: options.tier } : {}),
      },
    });
    if (error || !created.user) throw error ?? new Error("no user");
    const userId = created.user.id;

    const jar: CookieRecord[] = [];
    const client = createServerClient(API_URL, ANON_KEY, {
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

    // Saved through the Keys routes, as the Keys tab does.
    if (options.anthropicKey) {
      const r = await anthropicKey.POST(
        post("/api/account/anthropic-key", { key: options.anthropicKey }),
      );
      expect(r.status).toBe(200);
    }
    if (options.openAiKey) {
      const r = await openaiKey.POST(
        post("/api/account/openai-key", { key: options.openAiKey }),
      );
      expect(r.status).toBe(200);
    }

    const { data: nb } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "nb", system_prompt: "Answer briefly." })
      .select()
      .single();
    const { data: d } = await admin
      .from("discussions")
      .insert({ notebook_id: nb!.id, user_id: userId, name: "d" })
      .select()
      .single();
    return { userId, discussionId: d!.id as string };
  }

  const run = (discussionId: string, text = "What is PACT?") =>
    execute.POST(
      post("/api/execute", {
        discussionId,
        promptContent: plainTextToDoc(text),
      }),
    );

  async function rows(table: string, userId: string) {
    const { data } = await admin.from(table).select("*").eq("user_id", userId);
    return data ?? [];
  }

  test("Standard: OpenAI gets the key, the model and the system prompt; the answer and both model names are stored", async () => {
    const { userId, discussionId } = await user({
      provider: "openai",
      openAiKey: OPENAI_KEY,
    });
    openAiCalls.length = 0;
    const response = await run(discussionId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe("Hello from ChatGPT.");
    expect(body.resolved_model).toBe("gpt-6.1-sol-2026-09-01");
    expect(body.history_model).toBe("gpt-6.1-sol");

    expect(openAiCalls).toHaveLength(1);
    expect(openAiCalls[0].auth).toBe(`Bearer ${OPENAI_KEY}`);
    expect(openAiCalls[0].body).toMatchObject({
      model: "gpt-6.1-sol",
      stream: true,
      reasoning_effort: "low",
      max_completion_tokens: 40000,
      messages: [
        { role: "developer", content: "Answer briefly." },
        { role: "user", content: [{ type: "text", text: "What is PACT?" }] },
      ],
    });

    const [stored] = await rows("responses", userId);
    expect(stored.response).toBe("Hello from ChatGPT.");
    expect(stored.model).toBe("gpt-6.1-sol");
    expect(stored.resolved_model).toBe("gpt-6.1-sol-2026-09-01");
    // The lock is released and the run timed, as for Claude.
    await expect
      .poll(async () => (await rows("execution_locks", userId)).length)
      .toBe(0);
    await expect
      .poll(async () => (await rows("execution_timings", userId)).length)
      .toBe(1);
  });

  test("a second turn carries the first, in OpenAI's form; Economy is gpt-6-luna", async () => {
    const { discussionId } = await user({
      provider: "openai",
      tier: "economy",
      openAiKey: OPENAI_KEY,
    });
    nextOpenAiReply = () => openAiStream("gpt-6-luna-x", ["First answer."]);
    expect((await run(discussionId, "first question")).status).toBe(200);
    nextOpenAiReply = () => openAiStream("gpt-6-luna-x", ["Second answer."]);
    openAiCalls.length = 0;
    expect((await run(discussionId, "second question")).status).toBe(200);
    expect(openAiCalls[0].body.model).toBe("gpt-6-luna");
    expect(openAiCalls[0].body.messages).toEqual([
      { role: "developer", content: "Answer briefly." },
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: [{ type: "text", text: "second question" }] },
    ]);
    nextOpenAiReply = () =>
      openAiStream("gpt-6.1-sol-2026-09-01", ["Hello ", "from ", "ChatGPT."]);
  });

  test("Claude stays the default: with both keys saved and no choice made, the run goes to Anthropic", async () => {
    const { discussionId } = await user({
      openAiKey: OPENAI_KEY,
      anthropicKey: ANTHROPIC_KEY,
    });
    openAiCalls.length = 0;
    const before = anthropicCalls;
    await run(discussionId);
    expect(anthropicCalls).toBe(before + 1);
    expect(openAiCalls).toHaveLength(0);
  });

  test("ChatGPT chosen with no OpenAI key: the run does not start, and says where to fix it", async () => {
    const { userId, discussionId } = await user({
      provider: "openai",
      anthropicKey: ANTHROPIC_KEY,
    });
    openAiCalls.length = 0;
    const before = anthropicCalls;
    const response = await run(discussionId);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: OPENAI_MISSING_KEY_MESSAGE,
      code: "missing_openai_key",
    });
    expect(OPENAI_MISSING_KEY_MESSAGE).toContain("Account → Keys");
    expect(openAiCalls).toHaveLength(0);
    expect(anthropicCalls).toBe(before);
    expect(await rows("execution_locks", userId)).toHaveLength(0);
    expect(await rows("execution_timings", userId)).toHaveLength(0);
    expect(await rows("responses", userId)).toHaveLength(0);
  });

  async function refusedWith(status: number, error: object) {
    const { userId, discussionId } = await user({
      provider: "openai",
      openAiKey: OPENAI_KEY,
    });
    nextOpenAiReply = () => HttpResponse.json({ error }, { status });
    const logged: string[] = [];
    const spies = (["error", "warn", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args
            .map((a) =>
              a instanceof Error ? `${a.message} ${a.stack}` : String(a),
            )
            .join(" "),
        );
      }),
    );
    try {
      const response = await run(discussionId);
      const body = await response.json();
      // Never the key, in the answer or in any log line.
      expect(JSON.stringify(body)).not.toContain(OPENAI_KEY);
      for (const line of logged) {
        expect(line).not.toContain(OPENAI_KEY);
        expect(line).not.toContain("sk-proj-");
      }
      expect(await rows("responses", userId)).toHaveLength(0);
      return { status: response.status, body };
    } finally {
      spies.forEach((s) => s.mockRestore());
      nextOpenAiReply = () =>
        openAiStream("gpt-6.1-sol-2026-09-01", ["Hello ", "from ", "ChatGPT."]);
    }
  }

  test("a key OpenAI refuses: the Claude-style message, pointing to Account → Keys", async () => {
    const result = await refusedWith(401, {
      message: "Incorrect API key provided: sk-proj-************1234.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
    expect(result).toEqual({
      status: 400,
      body: { error: OPENAI_REJECTED_KEY_MESSAGE, code: "openai_rejected_key" },
    });
  });

  test("no API credit on the OpenAI account", async () => {
    const result = await refusedWith(429, {
      message: "You exceeded your current quota.",
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
    expect(result).toEqual({
      status: 400,
      body: { error: OPENAI_NO_CREDIT_MESSAGE, code: "openai_no_credit" },
    });
  });

  test("a rate limit", async () => {
    const result = await refusedWith(429, {
      message: "Rate limit reached for gpt-6.1-sol.",
      type: "requests",
      code: "rate_limit_exceeded",
    });
    expect(result).toEqual({
      status: 429,
      body: { error: OPENAI_RATE_LIMITED_MESSAGE, code: "openai_rate_limited" },
    });
  });

  test("a picture OpenAI cannot accept", async () => {
    const result = await refusedWith(400, {
      message: "You uploaded an unsupported image.",
      type: "invalid_request_error",
      code: "invalid_image_format",
    });
    expect(result).toEqual({
      status: 400,
      body: {
        error: OPENAI_ATTACHMENT_REFUSED_MESSAGE,
        code: "openai_attachment_refused",
      },
    });
  });

  test("any other failure keeps the generic message with an error id", async () => {
    const result = await refusedWith(500, {
      message: "The server had an error.",
    });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/^Execution failed/);
    expect(result.body.errorId).toBeTruthy();
  });
});

describe("/api/account/openai-key", () => {
  let admin: SupabaseClient;

  beforeAll(() => {
    const status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf-8",
      }),
    ) as { API_URL: string; SERVICE_ROLE_KEY: string };
    admin = createServiceClient(status.API_URL, status.SERVICE_ROLE_KEY);
  });

  async function signIn() {
    const status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf-8",
      }),
    ) as { API_URL: string; ANON_KEY: string };
    const email = `openai-key-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "openai key password 81!";
    const { data } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
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
    await client.auth.signInWithPassword({ email, password });
    currentCookies = jar;
    return data.user!.id;
  }

  const save = (route: typeof openaiKey, key: string) =>
    route.POST(post("/api/account/openai-key", { key }));
  const get = (route: typeof openaiKey, reveal = false) =>
    route.GET(
      new Request(
        `http://localhost/api/account/openai-key${reveal ? "?reveal=1" : ""}`,
      ),
    );

  test("checks the key gently, stores it encrypted, reveals it only on request", async () => {
    const userId = await signIn();
    expect(await (await get(openaiKey)).json()).toEqual({
      hasKey: false,
      hint: null,
    });

    const empty = await save(openaiKey, "  ");
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("Enter your OpenAI API key.");

    const wrong = await save(openaiKey, "pk-not-a-key");
    expect((await wrong.json()).error).toBe(
      'An OpenAI API key starts with "sk-".',
    );

    const anthropic = await save(
      openaiKey,
      "sk-ant-api03-pasted-in-the-wrong-field",
    );
    expect(anthropic.status).toBe(400);
    expect((await anthropic.json()).error).toMatch(
      /looks like an Anthropic key/,
    );

    const ok = await save(openaiKey, OPENAI_KEY);
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.hasKey).toBe(true);
    expect(JSON.stringify(okBody)).not.toContain(OPENAI_KEY);

    const { data: row } = await admin
      .from("user_api_keys")
      .select("openai_key_encrypted, anthropic_key_encrypted")
      .eq("user_id", userId)
      .single();
    expect(row!.openai_key_encrypted).not.toContain("sk-");
    expect(row!.openai_key_encrypted.startsWith("v1:")).toBe(true);
    expect(decryptSecret(row!.openai_key_encrypted)).toBe(OPENAI_KEY);
    expect(row!.anthropic_key_encrypted).toBeNull();

    const status = await (await get(openaiKey)).json();
    expect(status.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(OPENAI_KEY);
    expect(await (await get(openaiKey, true)).json()).toEqual({
      key: OPENAI_KEY,
    });
  });

  test("saving one key never clears the other", async () => {
    const userId = await signIn();
    await anthropicKey.POST(
      post("/api/account/anthropic-key", { key: ANTHROPIC_KEY }),
    );
    await save(openaiKey, OPENAI_KEY);
    await anthropicKey.POST(
      post("/api/account/anthropic-key", { key: `${ANTHROPIC_KEY}-2` }),
    );
    const { data: row } = await admin
      .from("user_api_keys")
      .select("openai_key_encrypted, anthropic_key_encrypted")
      .eq("user_id", userId)
      .single();
    expect(decryptSecret(row!.anthropic_key_encrypted)).toBe(
      `${ANTHROPIC_KEY}-2`,
    );
    expect(decryptSecret(row!.openai_key_encrypted)).toBe(OPENAI_KEY);
  });

  test("signed out: 401, nothing else", async () => {
    currentCookies = [];
    expect((await get(openaiKey)).status).toBe(401);
    expect((await save(openaiKey, OPENAI_KEY)).status).toBe(401);
  });
});
