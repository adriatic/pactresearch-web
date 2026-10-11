import { promptTooLongOvershoot } from "@/lib/historyBudget";
import { isAnthropicKeyRejection } from "@/lib/userAnthropicKey";
import {
  ProviderRequestError,
  type LlmProvider,
  type StreamEvent,
  type StreamRequest,
} from "./provider";

// Task 81 Stage 1. The Anthropic call, moved here unchanged from
// /api/execute: the same raw fetch() (no SDK), the same headers and body,
// the same streaming-event parsing.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Task 71. Browser tests need the WHOLE chain -- page, this route, the
// model's reply, the page again -- and cannot call the real model. A test
// that stores a key "sk-ant-e2e-mock-<port>" is answered by a local
// stand-in on that port, at PACT_E2E_ANTHROPIC_URL (set only by
// playwright.config.ts, with "{port}" in it). Never on Vercel: VERCEL_ENV
// is set on every Vercel deployment, and then this always returns the
// real address.
function anthropicUrlFor(apiKey: string): string {
  const mock = process.env.PACT_E2E_ANTHROPIC_URL;
  const port = /^sk-ant-e2e-mock-(\d{4,5})$/.exec(apiKey)?.[1];
  if (!process.env.VERCEL_ENV && mock && port) {
    return mock.replace("{port}", port);
  }
  return ANTHROPIC_API_URL;
}

export const anthropicProvider: LlmProvider = {
  name: "Anthropic",

  async stream(request: StreamRequest) {
    const response = await fetch(anthropicUrlFor(request.apiKey), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        stream: true,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages: [
          ...request.history,
          { role: "user", content: request.prompt },
        ],
      }),
    });

    if (!response.ok || !response.body) {
      // Anthropic's error responses are a JSON body describing exactly
      // what went wrong (bad/expired key, invalid_request_error for a bad
      // param, rate limit, etc.) -- read it now, while the response is
      // still available, so the real cause ends up in the thrown error's
      // own message rather than just a bare status code.
      const body = await response
        .text()
        .catch(() => "<failed to read response body>");
      throw new ProviderRequestError(
        "Anthropic",
        response.status,
        body,
        isAnthropicKeyRejection(response.status),
        promptTooLongOvershoot(response.status, body),
      );
    }

    return anthropicEvents(response.body);
  },
};

// Anthropic's server-sent events, reduced to the three the route acts on.
// Exported for its unit test.
export async function* anthropicEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line; the last (possibly
    // incomplete) chunk stays in the buffer for the next read.
    const rawEvents = buffer.split("\n\n");
    buffer = rawEvents.pop() ?? "";

    for (const rawEvent of rawEvents) {
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      const jsonText = dataLine.slice("data:".length).trim();
      if (!jsonText) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (event.type) {
        case "message_start": {
          const message = event.message as { model?: string } | undefined;
          yield { type: "start", resolvedModel: message?.model ?? null };
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as
            { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text", text: delta.text };
          }
          break;
        }
        case "message_stop":
          yield { type: "stop" };
          break;
        default:
          break;
      }
    }
  }
}
