import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { anthropicUrlFor } from "@/lib/llm/anthropic";
import {
  isAnthropicKeyRejection,
  REJECTED_KEY_CODE,
  REJECTED_KEY_MESSAGE,
  resolveUserAnthropicKey,
} from "@/lib/userAnthropicKey";
import { isResponseId, tooLongMessage } from "@/lib/diff/compareAnswers";
import {
  asFindings,
  MEANING_INSTRUCTION,
  MEANING_MODEL,
  MEANING_MODEL_NAME,
  MEANING_SCHEMA,
  meaningUserMessage,
} from "@/lib/diff/meaning";

// Task D15. The Meaning engine's one server call, ported from the
// diff-tests lab's route (app/api/compare-meaning/route.ts at 46ce062):
// the two stored answers go to Claude Opus 5.5, which lists the
// differences in meaning as findings.
//
// Three changes from the lab:
// - The key is the signed-in user's own Anthropic key (Account, Keys),
//   from resolveUserAnthropicKey, as /api/refine-system-prompt does. No
//   environment variable holds a key for this route.
// - Signed out answers 401, as every pact-web route does.
// - Anthropic is called with plain fetch (no SDK), at anthropicUrlFor's
//   address, so the browser tests' local stand-in can answer.
//
// The input is the two response ids, not the texts: the texts are read
// here with the session client, so row-level security keeps a user to
// their own answers, and the texts do not travel from the browser again.
//
// Never logged, printed or stored: the two texts, the key, Anthropic's
// answer or error body. Only the kind of failure and its status are
// logged.

const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 120_000;

const fail = (status: number, error: string, code?: string) =>
  Response.json(code ? { error, code } : { error }, { status });

const NOT_FOUND_MESSAGE = "Response not found";

async function handlePost(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail(401, "Unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "The request was not valid JSON.");
  }
  const { a, b } = (body ?? {}) as { a?: unknown; b?: unknown };

  // Both answers, read as the signed-in user. Another user's id, a
  // made-up one and a malformed one all read as "Response not found".
  const texts: Record<"A" | "B", string> = { A: "", B: "" };
  const missing: ("A" | "B")[] = [];
  for (const [side, id] of [
    ["A", a],
    ["B", b],
  ] as const) {
    if (!isResponseId(id)) {
      missing.push(side);
      continue;
    }
    const { data, error } = await supabase
      .from("responses")
      .select("response")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`responses read failed (${error.code ?? "?"})`);
    if (!data) missing.push(side);
    else texts[side] = (data.response as string | null) ?? "";
  }
  if (missing.length) {
    return fail(
      404,
      missing.map((side) => `Answer ${side}: ${NOT_FOUND_MESSAGE}`).join("\n"),
    );
  }

  const empty = (["A", "B"] as const).filter((side) => !texts[side].trim());
  if (empty.length) {
    return fail(
      400,
      empty
        .map(
          (side) =>
            `Answer ${side} has no text, so there is nothing to compare.`,
        )
        .join("\n"),
    );
  }
  const tooLong = tooLongMessage("meaning", texts.A, texts.B);
  if (tooLong) return fail(400, tooLong, "too_long");

  // The user's own key, with pact-web's messages for a missing,
  // unreadable or unconfigured one.
  const keyResult = await resolveUserAnthropicKey(supabase, user.id);
  if ("failure" in keyResult) {
    const { error, code, status } = keyResult.failure;
    return fail(status, error, code);
  }
  const apiKey = keyResult.key;

  // One attempt, two minutes at most.
  let response: Response;
  try {
    response = await fetch(anthropicUrlFor(apiKey), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MEANING_MODEL,
        max_tokens: MAX_TOKENS,
        system: MEANING_INSTRUCTION,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: MEANING_SCHEMA },
        },
        messages: [
          { role: "user", content: meaningUserMessage(texts.A, texts.B) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error(`[compare-meaning] request failed: ${name}`);
    if (name === "TimeoutError" || name === "AbortError") {
      return fail(504, "Anthropic did not answer within 120 seconds.");
    }
    return fail(502, "Could not reach Anthropic.");
  }

  if (!response.ok) {
    // The status only: Anthropic's error body is drained and dropped,
    // never logged or returned.
    await response.arrayBuffer().catch(() => null);
    console.error(`[compare-meaning] request failed: HTTP ${response.status}`);
    if (isAnthropicKeyRejection(response.status)) {
      return fail(400, REJECTED_KEY_MESSAGE, REJECTED_KEY_CODE);
    }
    if (response.status === 403) {
      return fail(
        502,
        `Your Anthropic key is not allowed to use ${MEANING_MODEL_NAME}. Check your Anthropic account.`,
      );
    }
    if (response.status === 429) {
      return fail(
        429,
        "Anthropic's rate limit was reached; try again in a minute.",
      );
    }
    return fail(
      502,
      `Anthropic answered with an error (HTTP ${response.status}); check your Anthropic account's credit and limits.`,
    );
  }

  const message = (await response.json().catch(() => null)) as {
    stop_reason?: string;
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  if (message?.stop_reason === "refusal") {
    return fail(502, "Claude declined to compare these two answers.");
  }
  if (message?.stop_reason === "max_tokens") {
    return fail(502, "Claude's answer was cut off before it was complete.");
  }
  const text = message?.content?.find((block) => block.type === "text")?.text;
  let parsed: unknown = null;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const findings = asFindings(parsed);
  if (!findings) {
    console.error("[compare-meaning] answer not in the expected shape");
    return fail(502, "Claude's answer was not in the expected shape.");
  }

  return Response.json({
    findings,
    usage: {
      inputTokens: message?.usage?.input_tokens ?? 0,
      outputTokens: message?.usage?.output_tokens ?? 0,
    },
  });
}

export const POST = withRouteErrorHandling(handlePost);
