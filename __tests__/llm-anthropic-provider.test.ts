import { afterEach, describe, expect, test, vi } from "vitest";
import { anthropicEvents, anthropicProvider } from "@/lib/llm/anthropic";
import { ProviderRequestError, type StreamEvent } from "@/lib/llm/provider";

// Task 81 Stage 1. The Anthropic provider behind the seam: its event
// parsing (moved unchanged from /api/execute) and the facts its typed
// error carries for the route.

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const sse = (event: object) =>
  `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

async function collect(body: ReadableStream<Uint8Array>) {
  const out: StreamEvent[] = [];
  for await (const e of anthropicEvents(body)) out.push(e);
  return out;
}

describe("anthropicEvents", () => {
  test("start, text pieces and stop, in order", async () => {
    const events = await collect(
      streamOf([
        sse({ type: "message_start", message: { model: "claude-x-1" } }),
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sse({ type: "ping" }),
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        }),
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        }),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        sse({ type: "message_stop" }),
      ]),
    );
    expect(events).toEqual([
      { type: "start", resolvedModel: "claude-x-1" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "stop" },
    ]);
  });

  test("an event split across network chunks is put back together", async () => {
    const whole =
      sse({ type: "message_start", message: { model: "m" } }) +
      sse({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "joined" },
      }) +
      sse({ type: "message_stop" });
    const pieces = whole.match(/[\s\S]{1,7}/g)!;
    expect(await collect(streamOf(pieces))).toEqual([
      { type: "start", resolvedModel: "m" },
      { type: "text", text: "joined" },
      { type: "stop" },
    ]);
  });

  test("ignores lines that are not events, broken JSON, empty and non-text deltas", async () => {
    const events = await collect(
      streamOf([
        ": comment line\n\n",
        "data: {not json\n\n",
        "data:\n\n",
        sse({
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        }),
        sse({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "" },
        }),
        sse({ type: "message_start", message: {} }),
      ]),
    );
    expect(events).toEqual([{ type: "start", resolvedModel: null }]);
  });

  test("a stream that ends without message_stop yields no stop", async () => {
    const events = await collect(
      streamOf([
        sse({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "cut" },
        }),
      ]),
    );
    expect(events).toEqual([{ type: "text", text: "cut" }]);
  });
});

describe("anthropicProvider.stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = {
    apiKey: "sk-ant-test",
    model: "claude-x-1",
    maxTokens: 100,
    systemPrompt: "Be brief.",
    history: [{ role: "assistant" as const, content: "earlier" }],
    prompt: [{ type: "text" as const, text: "hi" }],
  };

  test("sends Anthropic's request unchanged", async () => {
    const fetchMock = vi.fn(
      async () => new Response(streamOf([sse({ type: "message_stop" })])),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anthropicProvider.stream(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "claude-x-1",
      max_tokens: 100,
      stream: true,
      system: "Be brief.",
      messages: [
        { role: "assistant", content: "earlier" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
  });

  async function refusal(status: number, body: string) {
    vi.stubGlobal("fetch", async () => new Response(body, { status }));
    try {
      await anthropicProvider.stream(request);
    } catch (error) {
      return error as ProviderRequestError;
    }
    throw new Error("expected a refusal");
  }

  test("a refused key is flagged as the user's to fix", async () => {
    const error = await refusal(
      401,
      '{"error":{"type":"authentication_error"}}',
    );
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.keyRejected).toBe(true);
    expect(error.promptTooLongBy).toBeNull();
    expect(error.status).toBe(401);
  });

  test("prompt too long reports the overshoot", async () => {
    const error = await refusal(
      400,
      '{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    );
    expect(error.keyRejected).toBe(false);
    expect(error.promptTooLongBy).toBe(10000);
  });

  test("a rate limit is neither: the route's generic message handles it", async () => {
    const error = await refusal(429, '{"error":{"type":"rate_limit_error"}}');
    expect(error.keyRejected).toBe(false);
    expect(error.promptTooLongBy).toBeNull();
    expect(error.message).toBe(
      'Anthropic API request failed with status 429: {"error":{"type":"rate_limit_error"}}',
    );
  });
});
