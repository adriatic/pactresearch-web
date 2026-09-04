import { http, HttpResponse } from "msw";

export const mockAnthropicMessageResponse = {
  id: "msg_mock_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    {
      type: "text",
      text: "This is a mocked response from the Anthropic Messages API.",
    },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 12,
  },
};

export const handlers = [
  http.post("https://api.anthropic.com/v1/messages", () => {
    return HttpResponse.json(mockAnthropicMessageResponse);
  }),
];

// --- Streaming variant ---------------------------------------------------
// The flat-JSON handler above still backs __tests__/msw-harness.test.ts,
// which asserts a raw fetch response matches it directly — that test has
// nothing to do with app/api/execute/route.ts's SSE parsing, so it keeps
// the non-streaming shape. Now that the execute route always requests
// `stream: true`, any test exercising its success path needs this
// SSE-shaped handler instead, registered per-test/per-file via
// `server.use(createAnthropicStreamHandler())`.

export const mockAnthropicStreamedModel = "claude-sonnet-5";
export const mockAnthropicStreamedText =
  "This is a mocked streamed response from the Anthropic Messages API.";

function buildAnthropicSseBody(
  deltaDelayMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const words = mockAnthropicStreamedText.split(" ");

  const preludeEvents = [
    {
      type: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_mock_stream_01",
          type: "message",
          role: "assistant",
          model: mockAnthropicStreamedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      type: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
  ];

  const deltaEvents = words.map((word, index) => ({
    type: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: index === 0 ? word : ` ${word}` },
    },
  }));

  const finalEvents = [
    {
      type: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      type: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: words.length },
      },
    },
    { type: "message_stop", data: { type: "message_stop" } },
  ];

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of preludeEvents) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          ),
        );
      }

      for (const event of deltaEvents) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          ),
        );
        // message_start/content_block_start arrive near-instantly (matching
        // real Anthropic behavior); only the deltas that follow are spread
        // out, since that's the part a test needs real elapsed time to
        // observe mid-flight.
        if (deltaDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, deltaDelayMs));
        }
      }

      for (const event of finalEvents) {
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

// deltaDelayMs defaults to 0 (all events fire back-to-back, no real elapsed
// time) so most tests stay fast while still exercising the real multi-event
// SSE parsing loop; pass a real delay only for a test that needs a genuine
// window to observe mid-stream row state.
export function createAnthropicStreamHandler(deltaDelayMs = 0) {
  return http.post("https://api.anthropic.com/v1/messages", () => {
    return new HttpResponse(buildAnthropicSseBody(deltaDelayMs), {
      headers: { "content-type": "text/event-stream" },
    });
  });
}
