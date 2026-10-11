import type { AnthropicContentBlock } from "@/lib/promptContentToAnthropicBlocks";
import type { HistoryMessage } from "@/lib/discussionHistory";

// Task 81 Stage 1. The provider seam: the one shape /api/execute talks to,
// whichever model service answers: Anthropic (./anthropic.ts) and, since
// Stage 2, OpenAI (./openai.ts).
//
// Messages are carried in the content-block shape the app already builds
// (text blocks and base64 image blocks, lib/promptContentToAnthropicBlocks
// and lib/discussionHistory). It is Anthropic's own wire shape, which is
// why the Anthropic provider passes it straight through; any other
// provider translates it (text -> text, a base64 image -> its own image
// form). Keeping it, rather than inventing a neutral copy of the same two
// block types, is what lets Stage 1 change nothing on the Claude path.
export type ContentBlock = AnthropicContentBlock;
export type ChatMessage = HistoryMessage;

export interface StreamRequest {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt: string | null;
  // Earlier turns, oldest first, then the new prompt with its images.
  history: ChatMessage[];
  prompt: ContentBlock[];
}

// What a provider streams back, in order: one "start" (the model the
// service says actually ran -- null if it did not say), any number of
// "text" pieces, then one "stop" when the answer is complete. A stream
// that ends without "stop" was cut short; the route treats that exactly as
// it always has.
export type StreamEvent =
  | { type: "start"; resolvedModel: string | null }
  | { type: "text"; text: string }
  | { type: "stop" };

export interface LlmProvider {
  readonly name: string;
  // Sends the request. Resolves once the service has accepted it, with
  // the answer as a stream of events; a refusal throws ProviderRequestError
  // before any event exists.
  stream(request: StreamRequest): Promise<AsyncIterable<StreamEvent>>;
}

// Task 58's typed error, moved here so every provider raises the same
// thing. The route decides what the user sees from the two facts each
// provider fills in, never from the provider's own wording:
//   keyRejected   -- the service refused the user's key (theirs to fix in
//                    Account -> Keys, not a support matter);
//   promptTooLongBy -- the request did not fit the model's window, and by
//                    how many tokens (0 when the service did not say);
//                    null when that was not the problem.
// Task 81 Stage 2 adds a third, for refusals the user can act on that
// are neither of those (null for anything else, and always null from
// Anthropic, whose messages are unchanged):
//   reason -- "rate_limited", "no_credit" (the account has no API
//             credit), or "attachment_refused" (a picture was refused).
// The message keeps the service's own error body for the log line only;
// it is never shown to the user.
export type ProviderRefusalReason =
  "rate_limited" | "no_credit" | "attachment_refused";

export class ProviderRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    body: string,
    readonly keyRejected: boolean,
    readonly promptTooLongBy: number | null,
    readonly reason: ProviderRefusalReason | null = null,
  ) {
    super(`${provider} API request failed with status ${status}: ${body}`);
    this.name = "ProviderRequestError";
  }
}
