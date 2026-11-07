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
import { http, HttpResponse } from "msw";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { server } from "../mocks/server";
import { encryptSecret } from "@/lib/apiKeyCrypto";

// Task D15. /api/compare-meaning against the local Supabase, with the
// user's key a stand-in key "sk-ant-e2e-mock-<port>" that the route sends
// to PACT_E2E_ANTHROPIC_URL on 127.0.0.1, answered here by msw. Nothing
// real is called: even a missing handler would reach a closed local port.
//
// Every console line the route writes during these tests is collected,
// and none may contain either answer's text.

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

const PORT = 54599;
const MOCK_KEY = `sk-ant-e2e-mock-${PORT}`;
const MOCK_URL = `http://127.0.0.1:${PORT}/v1/messages`;

// Distinctive texts, so a log line carrying either would be caught.
const TEXT_A =
  "ZEBRA-ALPHA-7731 Use a central execution engine with provider adapters.";
const TEXT_B =
  "QUOKKA-BRAVO-4419 Use a central orchestrator with model adapters.";

const FINDINGS = [
  {
    topic: "Adapter naming",
    type: "conflict",
    a: "provider adapters",
    b: "model adapters",
    explanation: "Named after providers in A, after models in B.",
  },
  {
    topic: "Engine",
    type: "agreement",
    a: "central execution engine",
    b: "central orchestrator",
    explanation: "Both put one component in the middle.",
  },
];

const logged: string[] = [];
const { POST } = await import("@/app/api/compare-meaning/route");

describe("/api/compare-meaning", () => {
  let admin: SupabaseClient;
  let API_URL: string;
  let ANON_KEY: string;
  let calls: { body: Record<string, unknown>; key: string | null }[] = [];

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
    delete process.env.VERCEL_ENV;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
    server.listen({ onUnhandledRequest: "bypass" });

    // Collect every console line from here on.
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

  function answerWith(response: () => Response) {
    server.use(
      http.post(MOCK_URL, async ({ request }) => {
        calls.push({
          body: (await request.json()) as Record<string, unknown>,
          key: request.headers.get("x-api-key"),
        });
        return response();
      }),
    );
  }

  const okAnswer = () =>
    HttpResponse.json({
      id: "msg_meaning",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify({ findings: FINDINGS }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3512, output_tokens: 1840 },
    });

  async function signedInUser(opts: {
    key?: "mock" | "unreadable" | "none";
    texts?: [string, string];
  }) {
    const email = `meaning-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "meaning route D15 test!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");
    const userId = created.user.id;
    if (opts.key === "mock" || opts.key === undefined) {
      await admin.from("user_api_keys").upsert({
        user_id: userId,
        anthropic_key_encrypted: encryptSecret(MOCK_KEY),
      });
    } else if (opts.key === "unreadable") {
      await admin.from("user_api_keys").upsert({
        user_id: userId,
        anthropic_key_encrypted: "not-a-readable-stored-key",
      });
    }
    const { data: notebook } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Meaning notebook" })
      .select()
      .single();
    const { data: discussion } = await admin
      .from("discussions")
      .insert({
        notebook_id: notebook!.id,
        user_id: userId,
        name: "Meaning discussion",
      })
      .select()
      .single();
    const ids: string[] = [];
    for (const response of opts.texts ?? [TEXT_A, TEXT_B]) {
      const { data } = await admin
        .from("responses")
        .insert({
          discussion_id: discussion!.id,
          user_id: userId,
          prompt_text: "Which design?",
          response,
          model: "claude-sonnet-5",
          cell_type: "assistant",
        })
        .select("id")
        .single();
      ids.push(data!.id as string);
    }

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
    return { jar, a: ids[0], b: ids[1] };
  }

  const post = (body: unknown) =>
    POST(
      new Request("http://localhost/api/compare-meaning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("signed out: 401, and nothing is sent", async () => {
    answerWith(okAnswer);
    currentCookies = [];
    const response = await post({
      a: "00000000-0000-4000-8000-000000000000",
      b: "00000000-0000-4000-8000-000000000001",
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("a normal answer: the findings and the tokens used, from one request", async () => {
    const user = await signedInUser({});
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      findings: FINDINGS,
      usage: { inputTokens: 3512, outputTokens: 1840 },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.key).toBe(MOCK_KEY);
    expect(call.body.model).toBe("claude-opus-5-5");
    expect(call.body.output_config).toMatchObject({
      effort: "medium",
      format: { type: "json_schema" },
    });
    expect(call.body.stream).toBeUndefined();
    expect(typeof call.body.system).toBe("string");
    // The texts read on the server, as the signed-in user.
    const content = (call.body.messages as { content: string }[])[0].content;
    expect(content).toContain(`<response_a>\n${TEXT_A}\n</response_a>`);
    expect(content).toContain(`<response_b>\n${TEXT_B}\n</response_b>`);
  });

  test("no key saved: where to add it, and nothing is sent", async () => {
    const user = await signedInUser({ key: "none" });
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "Add your Anthropic API key in Account → Keys before running prompts.",
      code: "missing_anthropic_key",
    });
    expect(calls).toHaveLength(0);
  });

  test("a saved key that cannot be read: save it again, and nothing is sent", async () => {
    const user = await signedInUser({ key: "unreadable" });
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "Your saved Anthropic API key could not be read. Open Account → Keys and save it again.",
      code: "unreadable_anthropic_key",
    });
    expect(calls).toHaveLength(0);
  });

  test("a key Anthropic rejects: pact-web's rejected-key message", async () => {
    const user = await signedInUser({});
    currentCookies = user.jar;
    answerWith(() =>
      HttpResponse.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        { status: 401 },
      ),
    );
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Anthropic rejected your API key. Check it in Account → Keys.",
      code: "anthropic_rejected_key",
    });
    expect(calls).toHaveLength(1);
  });

  test("Anthropic fails: a plain message with the status, not the provider's body", async () => {
    const user = await signedInUser({});
    currentCookies = user.jar;
    answerWith(() =>
      HttpResponse.json(
        { type: "error", error: { type: "api_error", message: "BODY-SECRET" } },
        { status: 500 },
      ),
    );
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe(
      "Anthropic answered with an error (HTTP 500); check your Anthropic account's credit and limits.",
    );
    expect(logged.join("\n")).not.toContain("BODY-SECRET");
  });

  test("an answer in the wrong shape is refused", async () => {
    const user = await signedInUser({});
    currentCookies = user.jar;
    answerWith(() =>
      HttpResponse.json({
        content: [{ type: "text", text: '{"findings":[{"topic":"x"}]}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(
      "Claude's answer was not in the expected shape.",
    );
  });

  test("over 20,000 characters together: Meaning cannot run, and nothing is sent", async () => {
    const user = await signedInUser({
      texts: ["a".repeat(10_001), "b".repeat(10_000)],
    });
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "These two answers are too long for Meaning (Claude Opus 5.5): 20,001 characters together, and Meaning (Claude Opus 5.5) runs on up to 20,000. Meaning cannot run on them; use another engine.",
      code: "too_long",
    });
    expect(calls).toHaveLength(0);
  });

  test("exactly 20,000 characters together still runs", async () => {
    const user = await signedInUser({
      texts: ["a".repeat(10_000), "b".repeat(10_000)],
    });
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("another user's answer, a made-up id and a malformed id: Response not found, nothing sent", async () => {
    const stranger = await signedInUser({});
    const user = await signedInUser({});
    currentCookies = user.jar;
    answerWith(okAnswer);
    for (const b of [
      stranger.a,
      "00000000-0000-4000-8000-000000000000",
      "not-an-id",
    ]) {
      const response = await post({ a: user.a, b });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Answer B: Response not found",
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("an answer with no text: nothing to compare, nothing sent", async () => {
    const user = await signedInUser({ texts: [TEXT_A, "   "] });
    currentCookies = user.jar;
    answerWith(okAnswer);
    const response = await post({ a: user.a, b: user.b });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Answer B has no text, so there is nothing to compare.",
    );
    expect(calls).toHaveLength(0);
  });

  test("the two texts never appear in any log line", () => {
    // Runs last: by now every path above has logged what it logs.
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const marker of [
        "ZEBRA-ALPHA-7731",
        "QUOKKA-BRAVO-4419",
        "provider adapters",
        "central orchestrator",
        MOCK_KEY,
      ]) {
        expect(line).not.toContain(marker);
      }
    }
  });
});
