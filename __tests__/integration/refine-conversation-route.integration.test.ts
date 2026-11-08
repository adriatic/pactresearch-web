import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { delay, http, HttpResponse } from "msw";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { server } from "../mocks/server";
import { encryptSecret } from "@/lib/apiKeyCrypto";
import { refineWords, type RefineMessage } from "@/lib/refineConversation";

// Task D17d. /api/refine-conversation against the local Supabase. The
// user's key is a stand-in key -- "sk-ant-e2e-mock-<port>" for Claude,
// "sk-e2e-mock-openai-<port>" for ChatGPT -- that the providers send to
// PACT_E2E_ANTHROPIC_URL / PACT_E2E_OPENAI_URL on 127.0.0.1, answered
// here by msw. Nothing real is called: even a missing handler would reach
// a closed local port.
//
// Every console line written during these tests is collected; the last
// test checks that none carries a message, a reply, a system prompt, a
// key or a provider's error body.

// A short time limit, so the timeout case does not wait 60 seconds. The
// words still say 60 seconds: they are built inside the real module.
vi.mock("@/lib/refineConversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/refineConversation")>()),
  REFINE_TIMEOUT_MS: 1500,
}));

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
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

const ANTHROPIC_PORT = 54598;
const OPENAI_PORT = 54597;
const ANTHROPIC_KEY = `sk-ant-e2e-mock-${ANTHROPIC_PORT}`;
const OPENAI_KEY = `sk-e2e-mock-openai-${OPENAI_PORT}`;
const ANTHROPIC_URL = `http://127.0.0.1:${ANTHROPIC_PORT}/v1/messages`;
const OPENAI_URL = `http://127.0.0.1:${OPENAI_PORT}/v1/chat/completions`;

// Distinctive texts, so a log line carrying any of them would be caught.
const USER_TEXT = "PANGOLIN-4471 I study coral reef recovery after bleaching.";
const QUESTION = "MARMOSET-2290 What is your role in this research?";
const PROMPT_TEXT =
  "OCELOT-8813 You are a marine ecologist's careful research partner.";
const WITH_PROMPT = `Thank you.\n\nSYSTEM_PROMPT_START\n${PROMPT_TEXT}\nSYSTEM_PROMPT_END\n\nWould you like to refine it further?`;
const THINKING = "AXOLOTL-5512 hidden reasoning";
const BODY_SECRET = "BODY-SECRET-6630";

const logged: string[] = [];
const { GET, POST, PUT, DELETE } =
  await import("@/app/api/refine-conversation/route");

type Call = {
  provider: "anthropic" | "openai";
  body: Record<string, unknown>;
  key: string | null;
};

const user = (content = USER_TEXT): RefineMessage => ({
  role: "user",
  content,
});
const assistant = (
  content = QUESTION,
  provider: "anthropic" | "openai" = "anthropic",
): RefineMessage => ({ role: "assistant", content, provider });

const sse = (event: Record<string, unknown>) =>
  `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`;

// Claude's streamed answer: optional thinking, the text in two pieces,
// then the stop reason.
function anthropicStream(text: string, stopReason = "end_turn") {
  const half = Math.ceil(text.length / 2);
  const body =
    sse({ type: "message_start", message: { model: "claude-sonnet-5" } }) +
    sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: THINKING },
    }) +
    (text
      ? sse({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: text.slice(0, half) },
        }) +
        sse({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: text.slice(half) },
        })
      : "") +
    sse({ type: "message_delta", delta: { stop_reason: stopReason } }) +
    sse({ type: "message_stop" });
  return new HttpResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiStream(text: string, finishReason = "stop") {
  const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const body =
    (text
      ? data({
          model: "gpt-6.1-sol-2026-09-01",
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        })
      : "") +
    data({
      model: "gpt-6.1-sol-2026-09-01",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }) +
    "data: [DONE]\n\n";
  return new HttpResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("/api/refine-conversation", () => {
  let admin: SupabaseClient;
  let API_URL: string;
  let ANON_KEY: string;
  let calls: Call[] = [];

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    const status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf-8",
      }),
    ) as LocalSupabaseStatus;
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.PACT_E2E_ANTHROPIC_URL = "http://127.0.0.1:{port}/v1/messages";
    process.env.PACT_E2E_OPENAI_URL =
      "http://127.0.0.1:{port}/v1/chat/completions";
    delete process.env.VERCEL_ENV;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
    server.listen({ onUnhandledRequest: "bypass" });

    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args
            .map((x) =>
              x instanceof Error
                ? `${x.name}: ${x.message} ${x.stack ?? ""}`
                : typeof x === "string"
                  ? x
                  : JSON.stringify(x),
            )
            .join(" "),
        );
      });
    }
  }, 120000);

  afterEach(() => {
    server.resetHandlers();
    calls = [];
  });
  afterAll(() => {
    server.close();
    vi.restoreAllMocks();
  });

  function claudeAnswers(response: () => Response | Promise<Response>) {
    server.use(
      http.post(ANTHROPIC_URL, async ({ request }) => {
        calls.push({
          provider: "anthropic",
          body: (await request.json()) as Record<string, unknown>,
          key: request.headers.get("x-api-key"),
        });
        return response();
      }),
    );
  }

  function chatGptAnswers(response: () => Response | Promise<Response>) {
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        calls.push({
          provider: "openai",
          body: (await request.json()) as Record<string, unknown>,
          key: request.headers.get("authorization"),
        });
        return response();
      }),
    );
  }

  // Both stand-ins answer, so a test can see which one was called.
  function bothAnswer(text: string) {
    claudeAnswers(() => anthropicStream(text));
    chatGptAnswers(() => openAiStream(text));
  }

  async function signedInUser(
    opts: {
      provider?: "anthropic" | "openai";
      tier?: "standard" | "economy";
      key?: "mock" | "unreadable" | "none";
    } = {},
  ) {
    const provider = opts.provider ?? "anthropic";
    const email = `refine-route-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "refine route D17d test!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        llm_provider: provider,
        ...(opts.tier ? { model_tier: opts.tier } : {}),
      },
    });
    if (error || !created.user) throw error ?? new Error("no user");
    const userId = created.user.id;
    const column =
      provider === "openai"
        ? "openai_key_encrypted"
        : "anthropic_key_encrypted";
    const key = opts.key ?? "mock";
    if (key !== "none") {
      await admin.from("user_api_keys").upsert({
        user_id: userId,
        [column]:
          key === "mock"
            ? encryptSecret(provider === "openai" ? OPENAI_KEY : ANTHROPIC_KEY)
            : "not-a-readable-stored-key",
      });
    }
    const { data: notebook } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Refine notebook" })
      .select("id")
      .single();

    const jar: CookieRecord[] = [];
    const client = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => jar,
        setAll: (cs) =>
          cs.forEach(({ name, value }) => {
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
    return { jar, userId, notebookId: notebook!.id as string };
  }

  const url = (notebookId?: string) =>
    `http://localhost/api/refine-conversation${
      notebookId === undefined
        ? ""
        : `?notebookId=${encodeURIComponent(notebookId)}`
    }`;
  const send = (method: "POST" | "PUT", body: unknown) =>
    (method === "POST" ? POST : PUT)(
      new Request(url(), {
        method,
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const post = (body: unknown) => send("POST", body);
  const put = (body: unknown) => send("PUT", body);
  const get = (notebookId?: string) => GET(new Request(url(notebookId)));
  const del = (notebookId?: string) =>
    DELETE(new Request(url(notebookId), { method: "DELETE" }));

  async function storedMessages(notebookId: string) {
    const { data } = await admin
      .from("refine_conversations")
      .select("messages")
      .eq("notebook_id", notebookId)
      .maybeSingle();
    return (data?.messages as RefineMessage[] | undefined) ?? null;
  }

  async function storeDirectly(notebookId: string, messages: RefineMessage[]) {
    const { data: nb } = await admin
      .from("notebooks")
      .select("user_id")
      .eq("id", notebookId)
      .single();
    const { error } = await admin
      .from("refine_conversations")
      .upsert({ notebook_id: notebookId, user_id: nb!.user_id, messages });
    if (error) throw error;
  }

  const words = (
    refineCase: Parameters<typeof refineWords>[0],
    provider: "anthropic" | "openai",
    providerCode?: string,
  ) => refineWords(refineCase, provider, providerCode);

  describe("signed out", () => {
    test("401 on every method, and nothing is sent", async () => {
      bothAnswer(QUESTION);
      currentCookies = [];
      const someId = "00000000-0000-4000-8000-000000000000";
      for (const response of [
        await get(someId),
        await post({ notebookId: null, messages: [user()] }),
        await put({ notebookId: someId, messages: [user(), assistant()] }),
        await del(someId),
      ]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe("limits and shape: 400 before any key is read", () => {
    // The user's key cannot be read: if the route read it, the answer
    // would be the unreadable-key words instead of these.
    const cases: [string, unknown, Parameters<typeof refineWords>[0]][] = [
      [
        "41 messages",
        Array.from({ length: 41 }, (_, i) =>
          i % 2 ? assistant(`a${i}`) : user(`u${i}`),
        ),
        "too_many_messages",
      ],
      [
        "a user message of 2,001 characters",
        [user("x".repeat(2001))],
        "message_too_long",
      ],
      [
        "an assistant message of 12,001 characters",
        [user(), assistant("y".repeat(12001)), user()],
        "conversation_too_long",
      ],
      ["no messages", [], "invalid_conversation"],
      ["the assistant first", [assistant(), user()], "invalid_conversation"],
      ["the assistant last", [user(), assistant()], "invalid_conversation"],
      ["two user messages in a row", [user(), user()], "invalid_conversation"],
      [
        "a provider on a user message",
        [{ role: "user", content: "hi", provider: "openai" }],
        "invalid_conversation",
      ],
      ["messages missing", undefined, "invalid_conversation"],
    ];

    test.each(cases)("%s", async (_name, messages, refineCase) => {
      const u = await signedInUser({ key: "unreadable" });
      bothAnswer(QUESTION);
      const response = await post({ notebookId: u.notebookId, messages });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(words(refineCase, "anthropic"));
      expect(calls).toHaveLength(0);
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("60,000 characters in total pass the check; 60,001 do not", async () => {
      const u = await signedInUser({ key: "unreadable" });
      bothAnswer(QUESTION);
      const exactly: RefineMessage[] = [];
      for (let i = 0; i < 5; i += 1) {
        exactly.push(user("u".repeat(2000)), assistant("a".repeat(10000)));
      }
      exactly[9] = assistant("a".repeat(9999));
      exactly.push(user("u"));
      const atLimit = await post({ notebookId: null, messages: exactly });
      // Past the limits, so the key is read: the unreadable-key words.
      expect(await atLimit.json()).toEqual(
        words("unreadable_key", "anthropic"),
      );

      const over = [...exactly.slice(0, -1), user("uu")];
      const response = await post({ notebookId: null, messages: over });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        words("conversation_too_long", "anthropic"),
      );
      expect(calls).toHaveLength(0);
    });

    test("a body that is not JSON", async () => {
      await signedInUser({ key: "unreadable" });
      const response = await post("{not json");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        words("invalid_conversation", "anthropic"),
      );
    });
  });

  describe("a Claude account", () => {
    test("a normal reply: the right stand-in, model, key, instruction and history", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      bothAnswer(QUESTION);
      const sent = [user(), assistant("Which field?"), user("Marine ecology.")];
      const response = await post({ notebookId: null, messages: sent });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        reply: QUESTION,
        systemPrompt: null,
        incomplete: false,
        messages: [...sent, assistant(QUESTION, "anthropic")],
        saved: false,
        notice: null,
      });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.provider).toBe("anthropic");
      expect(call.key).toBe(ANTHROPIC_KEY);
      expect(call.body.model).toBe("claude-sonnet-5");
      expect(call.body.max_tokens).toBe(4096);
      expect(call.body.stream).toBe(true);
      expect(call.body.system).toContain(
        "Ask ONE clarifying question at a time",
      );
      expect(call.body.system).toContain(
        "SYSTEM_PROMPT_START\n(the system prompt)\nSYSTEM_PROMPT_END",
      );
      // History without the provider field, then the last message.
      expect(call.body.messages).toEqual([
        { role: "user", content: USER_TEXT },
        { role: "assistant", content: "Which field?" },
        { role: "user", content: [{ type: "text", text: "Marine ecology." }] },
      ]);
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("the Economy tier uses Claude's Economy model", async () => {
      await signedInUser({ provider: "anthropic", tier: "economy" });
      bothAnswer(QUESTION);
      expect(
        (await post({ notebookId: null, messages: [user()] })).status,
      ).toBe(200);
      expect(calls[0].body.model).toBe("claude-haiku-4-5");
    });

    test("thinking is skipped: only the text is the reply", async () => {
      await signedInUser({ provider: "anthropic" });
      bothAnswer(QUESTION);
      const body = await (
        await post({ notebookId: null, messages: [user()] })
      ).json();
      expect(body.reply).toBe(QUESTION);
      expect(JSON.stringify(body)).not.toContain(THINKING);
    });

    test("no key saved", async () => {
      await signedInUser({ provider: "anthropic", key: "none" });
      bothAnswer(QUESTION);
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(words("missing_key", "anthropic"));
      expect(calls).toHaveLength(0);
    });

    test("a saved key that cannot be read", async () => {
      await signedInUser({ provider: "anthropic", key: "unreadable" });
      bothAnswer(QUESTION);
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        words("unreadable_key", "anthropic"),
      );
      expect(calls).toHaveLength(0);
    });

    test("a key Anthropic rejects", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(() =>
        HttpResponse.json(
          {
            type: "error",
            error: { type: "authentication_error", message: BODY_SECRET },
          },
          { status: 401 },
        ),
      );
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(words("rejected_key", "anthropic"));
      expect(calls).toHaveLength(1);
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("a reply cut off at the limit: 502, nothing stored", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(() => anthropicStream(QUESTION, "max_tokens"));
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(words("cut_off", "anthropic"));
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("an empty reply: 502 naming Claude, nothing stored", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(() => anthropicStream("  \n "));
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "Claude returned nothing. Please try again.",
        code: "refine_empty_reply",
      });
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("no answer within the time limit: 504 naming Claude", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(async () => {
        await delay(4000);
        return anthropicStream(QUESTION);
      });
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: "Claude did not answer within 60 seconds. Please try again.",
        code: "refine_timeout",
      });
      expect(await storedMessages(u.notebookId)).toBeNull();
    }, 15000);

    test("an Anthropic error: 502 naming Claude, not the provider's body", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(() =>
        HttpResponse.json(
          { type: "error", error: { type: "api_error", message: BODY_SECRET } },
          { status: 500 },
        ),
      );
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual({
        error: "Couldn't get a reply from Claude. Please try again.",
        code: "refine_provider_error",
      });
      expect(await storedMessages(u.notebookId)).toBeNull();
    });
  });

  describe("a ChatGPT account", () => {
    test("a normal reply: the OpenAI stand-in, its model and key; the reply says openai", async () => {
      await signedInUser({ provider: "openai" });
      bothAnswer(QUESTION);
      const sent = [
        user(),
        assistant("Which field?", "anthropic"),
        user("Marine ecology."),
      ];
      const response = await post({ notebookId: null, messages: sent });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reply).toBe(QUESTION);
      expect(body.messages.at(-1)).toEqual(assistant(QUESTION, "openai"));
      // The earlier reply keeps the provider that wrote it.
      expect(body.messages[1]).toEqual(assistant("Which field?", "anthropic"));
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.provider).toBe("openai");
      expect(call.key).toBe(`Bearer ${OPENAI_KEY}`);
      expect(call.body.model).toBe("gpt-6.1-sol");
      expect(call.body.max_completion_tokens).toBe(4096);
      const messages = call.body.messages as {
        role: string;
        content: unknown;
      }[];
      expect(messages[0].role).toBe("developer");
      expect(messages[0].content).toContain(
        "Ask ONE clarifying question at a time",
      );
      expect(messages.slice(1)).toEqual([
        { role: "user", content: USER_TEXT },
        { role: "assistant", content: "Which field?" },
        { role: "user", content: [{ type: "text", text: "Marine ecology." }] },
      ]);
    });

    test("the Economy tier uses ChatGPT's Economy model", async () => {
      await signedInUser({ provider: "openai", tier: "economy" });
      bothAnswer(QUESTION);
      expect(
        (await post({ notebookId: null, messages: [user()] })).status,
      ).toBe(200);
      expect(calls[0].body.model).toBe("gpt-6-luna");
    });

    test("no key saved: the OpenAI words", async () => {
      await signedInUser({ provider: "openai", key: "none" });
      bothAnswer(QUESTION);
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "Refine with AI needs your OpenAI API key. Add it in Account → Keys, then try again. Nothing was sent.",
        code: "missing_openai_key",
      });
      expect(calls).toHaveLength(0);
    });

    test("a saved key that cannot be read: the OpenAI words", async () => {
      await signedInUser({ provider: "openai", key: "unreadable" });
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(words("unreadable_key", "openai"));
    });

    test("a key OpenAI rejects", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(() =>
        HttpResponse.json(
          {
            error: {
              message: `${BODY_SECRET} Incorrect API key provided: ${OPENAI_KEY}`,
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          { status: 401 },
        ),
      );
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(words("rejected_key", "openai"));
    });

    test("no credit: OpenAI's words with its own code", async () => {
      const u = await signedInUser({ provider: "openai" });
      chatGptAnswers(() =>
        HttpResponse.json(
          {
            error: {
              message: BODY_SECRET,
              type: "insufficient_quota",
              code: "credit_balance_exhausted",
            },
          },
          { status: 429 },
        ),
      );
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        words("no_credit", "openai", "credit_balance_exhausted"),
      );
      expect(await storedMessages(u.notebookId)).toBeNull();
    });

    test("a rate limit: 429 with OpenAI's words and code", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(() =>
        HttpResponse.json(
          {
            error: {
              message: BODY_SECRET,
              type: "requests",
              code: "rate_limit_exceeded",
            },
          },
          { status: 429 },
        ),
      );
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: `${refineWords("rate_limited", "openai").error} (OpenAI: rate_limit_exceeded)`,
        code: "openai_rate_limited",
      });
    });

    test("a reply cut off at the limit (finish_reason length)", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(() => openAiStream(QUESTION, "length"));
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(words("cut_off", "openai"));
    });

    test("an empty reply: 502 naming ChatGPT", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(() => openAiStream(""));
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe(
        "ChatGPT returned nothing. Please try again.",
      );
    });

    test("no answer within the time limit: 504 naming ChatGPT", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(async () => {
        await delay(4000);
        return openAiStream(QUESTION);
      });
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(504);
      expect((await response.json()).error).toBe(
        "ChatGPT did not answer within 60 seconds. Please try again.",
      );
    }, 15000);

    test("an OpenAI error: 502 naming ChatGPT", async () => {
      await signedInUser({ provider: "openai" });
      chatGptAnswers(() =>
        HttpResponse.json(
          { error: { message: BODY_SECRET, type: "server_error", code: null } },
          { status: 500 },
        ),
      );
      const response = await post({ notebookId: null, messages: [user()] });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "Couldn't get a reply from ChatGPT. Please try again.",
        code: "refine_provider_error",
      });
    });
  });

  describe("storing the conversation", () => {
    test("with a notebook: saved after a good reply, with the reply's provider", async () => {
      const u = await signedInUser({ provider: "openai" });
      bothAnswer(QUESTION);
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      const body = await response.json();
      expect(body.saved).toBe(true);
      expect(body.notice).toBeNull();
      expect(await storedMessages(u.notebookId)).toEqual([
        user(),
        assistant(QUESTION, "openai"),
      ]);
      const { data } = await admin
        .from("refine_conversations")
        .select("user_id, updated_at")
        .eq("notebook_id", u.notebookId)
        .single();
      expect(data!.user_id).toBe(u.userId);
      expect(Date.now() - Date.parse(data!.updated_at)).toBeLessThan(60000);
    });

    test("a second turn replaces the stored conversation", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      bothAnswer(WITH_PROMPT);
      const earlier = [user(), assistant(QUESTION, "anthropic")];
      await storeDirectly(u.notebookId, earlier);
      const sent = [...earlier, user("A doctoral student.")];
      const body = await (
        await post({ notebookId: u.notebookId, messages: sent })
      ).json();
      expect(body.saved).toBe(true);
      expect(await storedMessages(u.notebookId)).toEqual([
        ...sent,
        assistant(WITH_PROMPT, "anthropic"),
      ]);
    });

    test("after an error the stored conversation is unchanged", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      const earlier = [user(), assistant(QUESTION, "anthropic")];
      await storeDirectly(u.notebookId, earlier);
      claudeAnswers(() =>
        HttpResponse.json(
          { type: "error", error: { type: "api_error", message: BODY_SECRET } },
          { status: 529 },
        ),
      );
      const response = await post({
        notebookId: u.notebookId,
        messages: [...earlier, user("Next answer")],
      });
      expect(response.status).toBe(502);
      expect(await storedMessages(u.notebookId)).toEqual(earlier);
    });

    test("without a notebook nothing is saved", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      bothAnswer(QUESTION);
      const body = await (
        await post({ notebookId: null, messages: [user()] })
      ).json();
      expect(body.saved).toBe(false);
      expect(body.notice).toBeNull();
      const { count } = await admin
        .from("refine_conversations")
        .select("*", { count: "exact", head: true })
        .eq("user_id", u.userId);
      expect(count).toBe(0);
    });

    test("a reply that would take the conversation over the stored limit: returned, not saved", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      const earlier: RefineMessage[] = [];
      for (let i = 0; i < 5; i += 1) {
        earlier.push(user("u".repeat(2000)), assistant("a".repeat(9990)));
      }
      await storeDirectly(u.notebookId, earlier);
      // 59,960 characters, and the reply takes it past 60,000.
      const sent = [...earlier, user("u".repeat(10))];
      expect(QUESTION.length).toBeGreaterThan(40);
      bothAnswer(QUESTION);
      const response = await post({ notebookId: u.notebookId, messages: sent });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reply).toBe(QUESTION);
      expect(body.saved).toBe(false);
      expect(body.notice).toEqual(words("conversation_too_long", "anthropic"));
      expect(body.messages).toHaveLength(12);
      expect(await storedMessages(u.notebookId)).toEqual(earlier);
    });

    test("the notebook deleted while waiting: the reply is returned, saved false, save-failed words", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      claudeAnswers(async () => {
        await admin.from("notebooks").delete().eq("id", u.notebookId);
        return anthropicStream(QUESTION);
      });
      const response = await post({
        notebookId: u.notebookId,
        messages: [user()],
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reply).toBe(QUESTION);
      expect(body.saved).toBe(false);
      expect(body.notice).toEqual(words("save_failed", "anthropic"));
      expect(
        logged.some((l) =>
          /\[refine-conversation\] save failed \([0-9A-Z]+\)/.test(l),
        ),
      ).toBe(true);
    });
  });

  describe("the marked prompt", () => {
    test("a complete pair gives the system prompt", async () => {
      await signedInUser({ provider: "anthropic" });
      bothAnswer(WITH_PROMPT);
      const body = await (
        await post({ notebookId: null, messages: [user()] })
      ).json();
      expect(body.systemPrompt).toBe(PROMPT_TEXT);
      expect(body.incomplete).toBe(false);
      expect(body.reply).toBe(WITH_PROMPT);
    });

    test("only the start marker: no prompt, incomplete; the reply is still stored", async () => {
      const u = await signedInUser({ provider: "anthropic" });
      const unfinished = `Here it is:\nSYSTEM_PROMPT_START\n${PROMPT_TEXT}`;
      bothAnswer(unfinished);
      const body = await (
        await post({ notebookId: u.notebookId, messages: [user()] })
      ).json();
      expect(body.systemPrompt).toBeNull();
      expect(body.incomplete).toBe(true);
      expect(body.saved).toBe(true);
    });

    test("no markers: no prompt, not incomplete", async () => {
      await signedInUser({ provider: "anthropic" });
      bothAnswer(QUESTION);
      const body = await (
        await post({ notebookId: null, messages: [user()] })
      ).json();
      expect(body.systemPrompt).toBeNull();
      expect(body.incomplete).toBe(false);
    });
  });

  describe("GET, PUT and DELETE", () => {
    test("GET: [] when there is none, then the stored conversation", async () => {
      const u = await signedInUser();
      expect(await (await get(u.notebookId)).json()).toEqual({ messages: [] });
      const stored = [user(), assistant(QUESTION, "openai")];
      await storeDirectly(u.notebookId, stored);
      const response = await get(u.notebookId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: stored });
    });

    test("GET: a stored conversation that fails the check is not shown, and the notice says so (D17e2)", async () => {
      const u = await signedInUser();
      await storeDirectly(u.notebookId, [user("One."), user("Two.")]);
      const response = await get(u.notebookId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        messages: [],
        notice: {
          error:
            "The saved conversation for this notebook could not be read, so " +
            "it is not shown. Your next message starts a new conversation.",
          code: "refine_stored_unreadable",
        },
      });
    });

    test.each([
      ["missing", undefined],
      ["malformed", "not-a-uuid"],
      ["unknown", "00000000-0000-4000-8000-000000000000"],
    ])("GET with a %s notebook id: 404", async (_name, id) => {
      await signedInUser();
      const response = await get(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(
        words("notebook_not_found", "anthropic"),
      );
    });

    test("PUT stores a conversation that ends with the assistant, and GET reads it", async () => {
      const u = await signedInUser();
      const conversation = [user(), assistant(WITH_PROMPT, "anthropic")];
      const response = await put({
        notebookId: u.notebookId,
        messages: conversation,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await storedMessages(u.notebookId)).toEqual(conversation);
      expect(await (await get(u.notebookId)).json()).toEqual({
        messages: conversation,
      });
    });

    test("PUT replaces an existing conversation", async () => {
      const u = await signedInUser();
      await storeDirectly(u.notebookId, [user("old")]);
      const conversation = [user(), assistant()];
      expect(
        (await put({ notebookId: u.notebookId, messages: conversation }))
          .status,
      ).toBe(200);
      expect(await storedMessages(u.notebookId)).toEqual(conversation);
    });

    test.each<[string, unknown, Parameters<typeof refineWords>[0]]>([
      ["an empty conversation", [], "invalid_conversation"],
      ["a broken shape", [assistant()], "invalid_conversation"],
      [
        "41 messages",
        Array.from({ length: 41 }, (_, i) => (i % 2 ? assistant() : user())),
        "too_many_messages",
      ],
    ])(
      "PUT refuses %s with 400 and stores nothing",
      async (_name, messages, refineCase) => {
        const u = await signedInUser();
        const response = await put({ notebookId: u.notebookId, messages });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(words(refineCase, "anthropic"));
        expect(await storedMessages(u.notebookId)).toBeNull();
      },
    );

    test("PUT to a notebook that does not exist: 404", async () => {
      await signedInUser();
      const response = await put({
        notebookId: "00000000-0000-4000-8000-000000000000",
        messages: [user()],
      });
      expect(response.status).toBe(404);
    });

    test("DELETE removes the whole row; nothing to delete is still ok", async () => {
      const u = await signedInUser();
      await storeDirectly(u.notebookId, [user(), assistant()]);
      const response = await del(u.notebookId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await storedMessages(u.notebookId)).toBeNull();
      expect(await (await del(u.notebookId)).json()).toEqual({ ok: true });
      // The notebook itself stays.
      const { data } = await admin
        .from("notebooks")
        .select("id")
        .eq("id", u.notebookId);
      expect(data).toHaveLength(1);
    });

    test("DELETE with a malformed notebook id: 404", async () => {
      await signedInUser();
      expect((await del("not-a-uuid")).status).toBe(404);
      expect((await del()).status).toBe(404);
    });
  });

  describe("another user's notebook", () => {
    test("404 on GET, POST and PUT; DELETE changes nothing; nothing is sent", async () => {
      const owner = await signedInUser();
      const stored = [user(), assistant(QUESTION, "anthropic")];
      await storeDirectly(owner.notebookId, stored);

      await signedInUser(); // now signed in as someone else
      bothAnswer(QUESTION);
      const notFound = words("notebook_not_found", "anthropic");

      const getResponse = await get(owner.notebookId);
      expect(getResponse.status).toBe(404);
      expect(await getResponse.json()).toEqual(notFound);

      const postResponse = await post({
        notebookId: owner.notebookId,
        messages: [...stored, user("hijack")],
      });
      expect(postResponse.status).toBe(404);
      expect(await postResponse.json()).toEqual(notFound);
      expect(calls).toHaveLength(0);

      const putResponse = await put({
        notebookId: owner.notebookId,
        messages: [user("hijack")],
      });
      expect(putResponse.status).toBe(404);

      const delResponse = await del(owner.notebookId);
      expect(delResponse.status).toBe(200);
      expect(await storedMessages(owner.notebookId)).toEqual(stored);
    });
  });

  test("no log line carries a message, a reply, a system prompt, a key or a provider body", () => {
    // The tests above did write log lines (so this is not vacuous).
    const ours = logged.filter((l) => l.includes("[refine-conversation]"));
    expect(ours.length).toBeGreaterThan(5);
    for (const line of ours) {
      expect(line).toMatch(
        /^\[refine-conversation\] (failed provider=(anthropic|openai) status=\S+ code=\S+|timed out provider=(anthropic|openai)|cut off provider=(anthropic|openai)|empty reply provider=(anthropic|openai)|save failed \(\S+\)|stored conversation unreadable \(\S+\))$/,
      );
    }
    const all = logged.join("\n");
    for (const secret of [
      "PANGOLIN-4471",
      "MARMOSET-2290",
      "OCELOT-8813",
      "AXOLOTL-5512",
      BODY_SECRET,
      "Marine ecology.",
      "A doctoral student.",
      "hijack",
      ANTHROPIC_KEY,
      OPENAI_KEY,
      "Ask ONE clarifying question",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
