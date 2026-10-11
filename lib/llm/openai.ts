import {
  ProviderRequestError,
  type ChatMessage,
  type ContentBlock,
  type LlmProvider,
  type ProviderRefusalReason,
  type StreamEvent,
  type StreamRequest,
} from "./provider";

// Task 81 Stage 2. ChatGPT behind the provider seam.
//
// A plain fetch() to Chat Completions, not the openai package: it is the
// shape ./anthropic.ts already has (one request, one server-sent event
// stream read by hand), it adds no dependency, and the package's own
// retries and timeouts would sit between the route and the request where
// the route's timing spans and its one "too long" retry expect a single
// attempt. The request fields are the package's own type names (7.32.0).

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// The browser tests' local stand-in, as for Anthropic (anthropicUrlFor):
// a key "sk-e2e-mock-openai-<port>" is answered on that port, at
// PACT_E2E_OPENAI_URL (set only by playwright.config.ts). Never on
// Vercel, where VERCEL_ENV is always set.
function openaiUrlFor(apiKey: string): string {
  const mock = process.env.PACT_E2E_OPENAI_URL;
  const port = /^sk-e2e-mock-openai-(\d{4,5})$/.exec(apiKey)?.[1];
  if (!process.env.VERCEL_ENV && mock && port) {
    return mock.replace("{port}", port);
  }
  return OPENAI_API_URL;
}

// Both tiers' models are reasoning models, and max_completion_tokens
// counts their hidden reasoning as well as the answer. "low" is the least
// reasoning gpt-6.1-sol accepts ("none" is refused), and it keeps a run
// close to how Claude answers here, which is without extended thinking.
export const OPENAI_REASONING_EFFORT = "low";

type OpenAiPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// The app's content blocks in OpenAI's form: text as text, a base64 image
// as an image_url data URI (as pact-mac sent them).
export function toOpenAiParts(blocks: ContentBlock[]): OpenAiPart[] {
  return blocks.map((block) =>
    block.type === "image"
      ? {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        }
      : { type: "text", text: block.text },
  );
}

// The whole request body. Exported for its unit test.
export function openAiRequestBody(request: StreamRequest) {
  const history = request.history.map((message: ChatMessage) =>
    message.role === "user" && typeof message.content !== "string"
      ? { role: "user", content: toOpenAiParts(message.content) }
      : { role: message.role, content: message.content },
  );
  return {
    model: request.model,
    stream: true,
    max_completion_tokens: request.maxTokens,
    reasoning_effort: OPENAI_REASONING_EFFORT,
    messages: [
      // "developer" is what OpenAI's reasoning models take in place of
      // "system".
      ...(request.systemPrompt
        ? [{ role: "developer", content: request.systemPrompt }]
        : []),
      ...history,
      { role: "user", content: toOpenAiParts(request.prompt) },
    ],
  };
}

interface OpenAiErrorBody {
  error?: { message?: string; code?: string | null; param?: string | null };
}

function parseError(body: string): OpenAiErrorBody["error"] {
  try {
    return (JSON.parse(body) as OpenAiErrorBody).error ?? {};
  } catch {
    return {};
  }
}

// Anything key-shaped in a text bound for the log, and the key itself
// wherever it appears. Exported for its unit test.
export function redactKeys(text: string, apiKey: string): string {
  return text
    .split(apiKey)
    .join("[key]")
    .replace(/sk-[A-Za-z0-9_*.-]+/g, "[key]");
}

// What an OpenAI refusal means for the route. Exported for its unit test.
export function openAiRefusal(
  status: number,
  body: string,
): {
  keyRejected: boolean;
  promptTooLongBy: number | null;
  reason: ProviderRefusalReason | null;
} {
  const error = parseError(body) ?? {};
  const code = error.code ?? "";
  const message = error.message ?? "";

  let promptTooLongBy: number | null = null;
  if (status === 400 && code === "context_length_exceeded") {
    // "This model's maximum context length is 272000 tokens. However,
    // your messages resulted in 280000 tokens." -- or no numbers at all.
    const max = /maximum context length is (\d+)/i.exec(message)?.[1];
    const used = /resulted in (\d+) tokens/i.exec(message)?.[1];
    promptTooLongBy = max && used ? Math.max(0, Number(used) - Number(max)) : 0;
  }

  let reason: ProviderRefusalReason | null = null;
  if (status === 429) {
    reason = code === "insufficient_quota" ? "no_credit" : "rate_limited";
  } else if (
    status === 400 &&
    promptTooLongBy === null &&
    /image/i.test(`${code} ${error.param ?? ""} ${message}`)
  ) {
    reason = "attachment_refused";
  }

  // 401 only, as for Anthropic: a 403 is an account or region matter,
  // not a wrong key, and keeps the generic message and its error id.
  return { keyRejected: status === 401, promptTooLongBy, reason };
}

export const openaiProvider: LlmProvider = {
  name: "OpenAI",

  async stream(request: StreamRequest) {
    const response = await fetch(openaiUrlFor(request.apiKey), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(openAiRequestBody(request)),
    });

    if (!response.ok || !response.body) {
      // OpenAI's error body says what went wrong; it goes into the error
      // for the log line only. Its 401 quotes the key it refused, masked
      // except for the first and last few characters ("Incorrect API key
      // provided: sk-proj-****abcd") -- even that is taken out before it
      // can reach a log.
      const body = await response
        .text()
        .catch(() => "<failed to read response body>");
      const refusal = openAiRefusal(response.status, body);
      throw new ProviderRequestError(
        "OpenAI",
        response.status,
        redactKeys(body, request.apiKey),
        refusal.keyRejected,
        refusal.promptTooLongBy,
        refusal.reason,
      );
    }

    return openAiEvents(response.body);
  },
};

// OpenAI's streamed chunks, reduced to the route's three events: "start"
// on the first chunk (it carries the model that actually ran), "text" for
// each piece of the answer, "stop" on the closing "data: [DONE]". A stream
// that ends without [DONE] was cut short. Exported for its unit test.
export async function* openAiEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const rawEvents = buffer.split("\n\n");
    buffer = rawEvents.pop() ?? "";

    for (const rawEvent of rawEvents) {
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      const jsonText = dataLine.slice("data:".length).trim();
      if (!jsonText) continue;
      if (jsonText === "[DONE]") {
        if (!started) {
          started = true;
          yield { type: "start", resolvedModel: null };
        }
        yield { type: "stop" };
        continue;
      }

      let chunk: {
        model?: string;
        choices?: { delta?: { content?: string | null } }[];
        error?: unknown;
      };
      try {
        chunk = JSON.parse(jsonText);
      } catch {
        continue;
      }
      // An error sent mid-stream: the answer stops here, unfinished, and
      // the stream ends without [DONE].
      if (chunk.error) continue;

      if (!started) {
        started = true;
        yield { type: "start", resolvedModel: chunk.model ?? null };
      }
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield { type: "text", text };
    }
  }
}
