import { afterEach, describe, expect, test, vi } from "vitest";
import {
  openAiReasonCode,
  redactKeys,
  openAiEvents,
  openAiRefusal,
  openAiRequestBody,
  openaiProvider,
  toOpenAiParts,
} from "@/lib/llm/openai";
import { ProviderRequestError, type StreamEvent } from "@/lib/llm/provider";

// Task 81 Stage 2. The OpenAI provider behind the seam: the history and
// pictures in OpenAI's form, its streamed chunks as the route's three
// events, and what each refusal means for the user.

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const data = (chunk: object | string) =>
  `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`;

const chunk = (content: string | null, model = "gpt-6.1-sol-2026-09-01") => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  model,
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

async function collect(body: ReadableStream<Uint8Array>) {
  const out: StreamEvent[] = [];
  for await (const e of openAiEvents(body)) out.push(e);
  return out;
}

const PNG = {
  type: "base64" as const,
  media_type: "image/png",
  data: "iVBORw0KGgo=",
};

describe("toOpenAiParts and the request body", () => {
  test("text stays text; a picture becomes an image_url data URI", () => {
    expect(
      toOpenAiParts([
        { type: "text", text: "look" },
        { type: "image", source: PNG },
      ]),
    ).toEqual([
      { type: "text", text: "look" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ]);
  });

  test("system prompt as developer, history in order with its pictures, then the prompt", () => {
    const body = openAiRequestBody({
      apiKey: "sk-test",
      model: "gpt-6.1-sol",
      maxTokens: 40000,
      systemPrompt: "Be brief.",
      history: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "this one" },
            { type: "image", source: PNG },
          ],
        },
        { role: "assistant", content: "a chart" },
      ],
      prompt: [{ type: "text", text: "and now?" }],
    });
    expect(body).toEqual({
      model: "gpt-6.1-sol",
      stream: true,
      max_completion_tokens: 40000,
      reasoning_effort: "low",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "this one" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            },
          ],
        },
        { role: "assistant", content: "a chart" },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
    });
  });

  test("no system prompt sends no developer message", () => {
    const body = openAiRequestBody({
      apiKey: "sk-test",
      model: "gpt-6-luna",
      maxTokens: 10,
      systemPrompt: null,
      history: [],
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });
});

describe("openAiEvents", () => {
  test("start with the model that ran, text pieces, stop on [DONE]", async () => {
    expect(
      await collect(
        streamOf([
          data({
            ...chunk(""),
            choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
          }),
          data(chunk("Hel")),
          data(chunk("lo")),
          data({
            ...chunk(null),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
          data("[DONE]"),
        ]),
      ),
    ).toEqual([
      { type: "start", resolvedModel: "gpt-6.1-sol-2026-09-01" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "stop" },
    ]);
  });

  test("a chunk split across network reads is put back together", async () => {
    const whole = data(chunk("joined", "m")) + data("[DONE]");
    const pieces = whole.match(/[\s\S]{1,5}/g)!;
    expect(await collect(streamOf(pieces))).toEqual([
      { type: "start", resolvedModel: "m" },
      { type: "text", text: "joined" },
      { type: "stop" },
    ]);
  });

  test("a stream cut short has no stop; an error chunk adds nothing", async () => {
    expect(
      await collect(
        streamOf([
          ": keep-alive\n\n",
          "data: {broken\n\n",
          data(chunk("cut")),
          data({ error: { message: "server error" } }),
        ]),
      ),
    ).toEqual([
      { type: "start", resolvedModel: "gpt-6.1-sol-2026-09-01" },
      { type: "text", text: "cut" },
    ]);
  });

  test("an empty answer still starts and stops", async () => {
    expect(await collect(streamOf([data("[DONE]")]))).toEqual([
      { type: "start", resolvedModel: null },
      { type: "stop" },
    ]);
  });
});

describe("openAiRefusal", () => {
  const body = (code: string | null, message: string, param?: string) =>
    JSON.stringify({
      error: { message, type: "invalid_request_error", param, code },
    });

  test("401 is the user's key", () => {
    expect(
      openAiRefusal(401, body("invalid_api_key", "Incorrect API key provided")),
    ).toEqual({
      keyRejected: true,
      promptTooLongBy: null,
      reason: null,
    });
  });

  test("429 insufficient_quota is no credit; any other 429 is a rate limit", () => {
    expect(
      openAiRefusal(
        429,
        body("insufficient_quota", "You exceeded your current quota"),
      ).reason,
    ).toBe("no_credit");
    expect(
      openAiRefusal(429, body("rate_limit_exceeded", "Rate limit reached"))
        .reason,
    ).toBe("rate_limited");
    expect(openAiRefusal(429, "not json").reason).toBe("rate_limited");
  });

  test("context_length_exceeded reports the overshoot, or 0 without numbers", () => {
    expect(
      openAiRefusal(
        400,
        body(
          "context_length_exceeded",
          "This model's maximum context length is 272000 tokens. However, your messages resulted in 280500 tokens.",
        ),
      ),
    ).toEqual({ keyRejected: false, promptTooLongBy: 8500, reason: null });
    expect(
      openAiRefusal(400, body("context_length_exceeded", "Input too long."))
        .promptTooLongBy,
    ).toBe(0);
  });

  test("a 400 about a picture is attachment_refused", () => {
    expect(
      openAiRefusal(400, body("invalid_image_format", "Invalid image.")).reason,
    ).toBe("attachment_refused");
    expect(
      openAiRefusal(
        400,
        body(
          null,
          "You uploaded an unsupported image.",
          "messages.[0].content.[1].image_url",
        ),
      ).reason,
    ).toBe("attachment_refused");
  });

  test("anything else is none of these: the generic message", () => {
    expect(openAiRefusal(400, body("invalid_value", "Bad model"))).toEqual({
      keyRejected: false,
      promptTooLongBy: null,
      reason: null,
    });
    expect(
      openAiRefusal(
        403,
        body("unsupported_country_region_territory", "Country not supported"),
      ).keyRejected,
    ).toBe(false);
    expect(openAiRefusal(500, "").reason).toBeNull();
  });
});

describe("OpenAI's 429s, as documented (Nik's Preview run, 2026-10-11)", () => {
  // The body OpenAI sent Nik's first Preview run, verbatim from the
  // Preview's log. It was shown as a rate limit.
  const NIK_PREVIEW_429 = JSON.stringify({
    error: {
      message:
        "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      type: "insufficient_quota",
      param: null,
      code: "credit_balance_exhausted",
    },
  });

  test("credit_balance_exhausted is no credit, not a rate limit", () => {
    expect(openAiRefusal(429, NIK_PREVIEW_429).reason).toBe("no_credit");
    expect(openAiReasonCode(429, NIK_PREVIEW_429)).toBe(
      "credit_balance_exhausted",
    );
  });

  test("any 429 of type insufficient_quota is no credit, whatever its code", () => {
    const body = JSON.stringify({
      error: {
        message: "x",
        type: "insufficient_quota",
        code: "some_future_code",
      },
    });
    expect(openAiRefusal(429, body).reason).toBe("no_credit");
  });

  test("the spend and usage limit codes are spend_limit", () => {
    for (const code of [
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
    ]) {
      const body = JSON.stringify({
        error: { message: "x", type: "requests", code },
      });
      expect(openAiRefusal(429, body).reason).toBe("spend_limit");
    }
  });

  test("only rate_limit_exceeded, slow-down and unknown 429s are a rate limit", () => {
    for (const code of ["rate_limit_exceeded", "slow_down", null]) {
      const body = JSON.stringify({
        error: { message: "x", type: "requests", code },
      });
      expect(openAiRefusal(429, body).reason).toBe("rate_limited");
    }
  });
});

describe("openAiReasonCode", () => {
  test("the code, else the type, else the HTTP status", () => {
    expect(
      openAiReasonCode(
        401,
        JSON.stringify({
          error: { code: "invalid_api_key", type: "invalid_request_error" },
        }),
      ),
    ).toBe("invalid_api_key");
    expect(
      openAiReasonCode(
        500,
        JSON.stringify({ error: { code: null, type: "server_error" } }),
      ),
    ).toBe("server_error");
    expect(openAiReasonCode(502, "<html>Bad gateway</html>")).toBe("HTTP 502");
  });

  test("never anything but a short code: no spaces, no key, no message", () => {
    const body = JSON.stringify({
      error: {
        code: "sk-proj-abc def",
        type: "Incorrect API key provided: sk-proj-***1234",
      },
    });
    expect(openAiReasonCode(401, body)).toBe("HTTP 401");
    expect(
      openAiReasonCode(
        400,
        JSON.stringify({ error: { code: "x".repeat(61) } }),
      ),
    ).toBe("HTTP 400");
  });
});

describe("openaiProvider.stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = {
    apiKey: "sk-proj-secret-test-key",
    model: "gpt-6-luna",
    maxTokens: 100,
    systemPrompt: null,
    history: [],
    prompt: [{ type: "text" as const, text: "hi" }],
  };

  test("sends the key as a Bearer header to OpenAI, and nowhere else", async () => {
    const fetchMock = vi.fn(
      async () => new Response(streamOf([data("[DONE]")])),
    );
    vi.stubGlobal("fetch", fetchMock);
    await openaiProvider.stream(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-proj-secret-test-key",
    });
    expect(init.body as string).not.toContain("sk-proj-secret-test-key");
  });

  test("the e2e stand-in is used only for its own key, and never on Vercel", async () => {
    const fetchMock = vi.fn(
      async () => new Response(streamOf([data("[DONE]")])),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv(
      "PACT_E2E_OPENAI_URL",
      "http://127.0.0.1:{port}/v1/chat/completions",
    );
    try {
      await openaiProvider.stream({
        ...request,
        apiKey: "sk-e2e-mock-openai-54400",
      });
      await openaiProvider.stream(request);
      vi.stubEnv("VERCEL_ENV", "preview");
      await openaiProvider.stream({
        ...request,
        apiKey: "sk-e2e-mock-openai-54400",
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]),
    ).toEqual([
      "http://127.0.0.1:54400/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]);
  });

  test("a refusal throws ProviderRequestError with the facts, and without the key", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Incorrect API key provided: sk-proj-*****-key.",
              code: "invalid_api_key",
            },
          }),
          { status: 401 },
        ),
    );
    const error = await openaiProvider.stream(request).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as ProviderRequestError,
    );
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.provider).toBe("OpenAI");
    expect(error.keyRejected).toBe(true);
    expect(error.message).not.toContain("sk-proj-secret-test-key");
    // Not even OpenAI's masked copy of it.
    expect(error.message).not.toContain("sk-proj-*****-key");
    expect(error.message).toContain("Incorrect API key provided: [key]");
  });

  test("redactKeys takes out the key and anything key-shaped", () => {
    expect(
      redactKeys(
        "bad sk-proj-abc*****wxyz and the-key-itself",
        "the-key-itself",
      ),
    ).toBe("bad [key] and [key]");
    expect(redactKeys("no key here", "sk-x")).toBe("no key here");
  });
});
