import { describe, expect, test, vi } from "vitest";
import { anthropicEvents, anthropicProvider } from "@/lib/llm/anthropic";
import { openAiEvents, openaiProvider } from "@/lib/llm/openai";
import type { StreamEvent } from "@/lib/llm/provider";

// Task D17b. The optional cutOff flag on the stop event: set when the
// service ended the answer at the output limit, absent otherwise, so
// /api/execute (which never reads it) sees exactly the events it saw.

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const sse = (event: { type: string }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function anthropicStream(stopReason: string | null) {
  return streamOf([
    sse({ type: "message_start", message: { model: "claude-x" } } as never),
    sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    } as never),
    sse({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 4096 },
    } as never),
    sse({ type: "message_stop" }),
  ]);
}

describe("anthropicEvents: cutOff", () => {
  test('stop_reason "max_tokens" puts cutOff: true on the stop event', async () => {
    const events = await collect(
      anthropicEvents(anthropicStream("max_tokens")),
    );
    expect(events.at(-1)).toStrictEqual({ type: "stop", cutOff: true });
    expect(events).toHaveLength(3);
  });

  test('stop_reason "end_turn" leaves the stop event exactly { type: "stop" }', async () => {
    const events = await collect(anthropicEvents(anthropicStream("end_turn")));
    expect(events.at(-1)).toStrictEqual({ type: "stop" });
    expect("cutOff" in events.at(-1)!).toBe(false);
  });

  test("a message_delta with no stop_reason is not a cut-off", async () => {
    const events = await collect(anthropicEvents(anthropicStream(null)));
    expect(events.at(-1)).toStrictEqual({ type: "stop" });
  });

  test("a stream that ends at the limit without message_stop has no stop at all", async () => {
    const events = await collect(
      anthropicEvents(
        streamOf([
          sse({ type: "message_start", message: { model: "m" } } as never),
          sse({
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
          } as never),
        ]),
      ),
    );
    expect(events).toStrictEqual([{ type: "start", resolvedModel: "m" }]);
  });
});

const data = (payload: object | string) =>
  `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;

function openAiStream(finishReason: string | null) {
  return streamOf([
    data({
      model: "gpt-x",
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    }),
    data({
      model: "gpt-x",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }),
    data("[DONE]"),
  ]);
}

describe("openAiEvents: cutOff", () => {
  test('finish_reason "length" puts cutOff: true on the stop event', async () => {
    const events = await collect(openAiEvents(openAiStream("length")));
    expect(events).toStrictEqual([
      { type: "start", resolvedModel: "gpt-x" },
      { type: "text", text: "Hello" },
      { type: "stop", cutOff: true },
    ]);
  });

  test('finish_reason "stop" leaves the stop event exactly { type: "stop" }', async () => {
    const events = await collect(openAiEvents(openAiStream("stop")));
    expect(events.at(-1)).toStrictEqual({ type: "stop" });
    expect("cutOff" in events.at(-1)!).toBe(false);
  });

  test('"length" on the same chunk as the last text still counts', async () => {
    const events = await collect(
      openAiEvents(
        streamOf([
          data({
            model: "gpt-x",
            choices: [
              { index: 0, delta: { content: "Hel" }, finish_reason: "length" },
            ],
          }),
          data("[DONE]"),
        ]),
      ),
    );
    expect(events).toStrictEqual([
      { type: "start", resolvedModel: "gpt-x" },
      { type: "text", text: "Hel" },
      { type: "stop", cutOff: true },
    ]);
  });
});

// Task D17d. The optional abort signal reaches fetch for both providers
// (Refine's time limit), and a request without one sends none, as
// /api/execute's requests always have.
describe("StreamRequest.signal", () => {
  const request = {
    apiKey: "sk-test",
    model: "m",
    maxTokens: 10,
    systemPrompt: null,
    history: [],
    prompt: [{ type: "text" as const, text: "hi" }],
  };

  test.each([
    ["Anthropic", anthropicProvider],
    ["OpenAI", openaiProvider],
  ])(
    "%s passes the signal to fetch, and none when not given",
    async (_name, provider) => {
      const fetchMock = vi.fn(
        async () =>
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        const controller = new AbortController();
        await provider.stream({ ...request, signal: controller.signal });
        await provider.stream(request);
        const inits = fetchMock.mock.calls.map(
          (call) => (call as unknown as [string, RequestInit])[1],
        );
        expect(inits[0].signal).toBe(controller.signal);
        expect(inits[1].signal).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
