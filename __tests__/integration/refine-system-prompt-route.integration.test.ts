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

// Task 58. /api/refine-system-prompt shares /api/execute's per-user key
// path (both moved to it in task 51), so it must share its diagnosis:
// the same refused key telling the user two different stories depending
// on which button they pressed is exactly what the shared message
// constants exist to prevent.
//
// This route had no integration coverage at all -- the E2E mocks it at
// the browser network layer, which exercises the dialog and never the
// route's own error handling.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
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

const { POST } = await import("@/app/api/refine-system-prompt/route");

describe("/api/refine-system-prompt", () => {
  let admin: SupabaseClient;
  let API_URL: string;
  let ANON_KEY: string;

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString(
      "base64",
    );
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
    server.listen({ onUnhandledRequest: "bypass" });
  }, 120000);

  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  async function signedInWithKey() {
    const email = `refine-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 58!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");

    // A well-formed key, stored and decryptable. The point of this task
    // is the case where everything on our side is fine.
    await admin.from("user_api_keys").upsert({
      user_id: created.user.id,
      anthropic_key_encrypted: encryptSecret("sk-ant-well-formed-but-revoked"),
    });

    const jar: CookieRecord[] = [];
    const jarClient = createServerClient(API_URL, ANON_KEY, {
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
    const { error: signInError } = await jarClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    return jar;
  }

  function refineRequest() {
    return new Request("http://localhost/api/refine-system-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Oncology trial protocol review" }),
    });
  }

  test("a key Anthropic rejects with 401 produces the same actionable message as /api/execute", async () => {
    currentCookies = await signedInWithKey();
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          },
          { status: 401 },
        ),
      ),
    );

    const response = await POST(refineRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("anthropic_rejected_key");
    // Byte-identical to what /api/execute returns -- one refused key,
    // one story.
    expect(body.error).toBe(
      "Anthropic rejected your API key. Check it in Account → Keys.",
    );
    expect(body.error).not.toMatch(/Couldn't draft/i);
    // Nothing from Anthropic's body reaches the browser.
    expect(body.error).not.toMatch(/authentication_error|x-api-key/);
  });

  test("a non-401 Anthropic failure keeps the route's own generic message and error id", async () => {
    currentCookies = await signedInWithKey();
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

    const response = await POST(refineRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toMatch(/Couldn't draft a system prompt/i);
    expect(body.errorId).toEqual(expect.any(String));
    expect(body.error).not.toMatch(/Anthropic rejected/i);
  });

  test("a successful draft is unaffected", async () => {
    currentCookies = await signedInWithKey();
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          content: [
            { type: "text", text: "You are reviewing trial protocols." },
          ],
        }),
      ),
    );

    const response = await POST(refineRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.systemPrompt).toBe("You are reviewing trial protocols.");
  });
});
