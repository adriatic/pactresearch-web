import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { trace, context } from "@opentelemetry/api";

const tracer = trace.getTracer("pact-api");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// Minimum time between UPDATEs to the responses row while content streams
// in. Anthropic's content_block_delta events can arrive many times a
// second — writing to Postgres on every single one would be wasteful and
// buys nothing, since no human (or Realtime-subscribed UI) can perceive
// updates faster than this anyway.
//
// 2000ms, not the original 500ms: measured and proven on the instrumented
// clone (pactresearch-web-instrumented) before porting here, not a guess
// made fresh against production. That investigation found these throttled
// writes costing 19-34% of total request time at 500ms across five real
// discussions (write count tracks generation_ms / interval almost
// exactly), dominated by fixed per-HTTP-call overhead (auth/RLS/PostgREST
// per round trip, not the UPDATE's own cost) rather than anything that
// scales with payload size -- so raising the interval directly cuts that
// cost with no change to the final-write durability guarantee below. A
// real before/after on the clone at this same 2000ms value measured write
// cost dropping from 19.4% to 4.5% of total request time on a matched
// pair of comparable-length responses. Live-preview UI (Realtime
// `postgres_changes` subscription) updates roughly every 2s during
// generation instead of every 500ms -- still clearly "streaming" at
// human reading speed.
const STREAM_WRITE_THROTTLE_MS = 2000;

interface ExecuteRequestBody {
  discussionId: string;
  promptText: string;
}

async function handlePost(request: Request) {
  const supabase = await createClient();

  const user = await tracer.startActiveSpan("auth", async (span) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user;
    } finally {
      span.end();
    }
  });

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not configured" },
      { status: 500 },
    );
  }

  let discussionId: string;
  let promptText: string;
  try {
    const body = (await request.json()) as ExecuteRequestBody;
    discussionId = body.discussionId;
    promptText = body.promptText;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }
  // Attaches to the automatic root span @vercel/otel creates for this
  // route invocation -- an attribute, not part of the span name, since
  // high-cardinality values (a per-request uuid) belong on attributes,
  // not names. Replaces the old HandlerTimer.setLabel mechanism.
  trace.getActiveSpan()?.setAttribute("pact.discussion_id", discussionId);

  if (typeof promptText !== "string" || promptText.trim().length === 0) {
    return Response.json(
      { error: "promptText is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  const { acquired, lockError } = await tracer.startActiveSpan(
    "lock-acquire",
    async (span) => {
      try {
        const { data, error } = await supabase.rpc(
          "try_acquire_execution_lock",
          { p_user_id: user.id, p_discussion_id: discussionId },
        );
        return { acquired: data, lockError: error };
      } finally {
        span.end();
      }
    },
  );

  if (lockError) {
    throw lockError;
  }

  if (!acquired) {
    return Response.json(
      { error: "An execution is already in progress for this user." },
      { status: 409 },
    );
  }

  // time-to-first-token's own lifetime spans multiple iterations of the
  // SSE read loop below (from the Anthropic fetch call until the first
  // real text_delta), so it can't be a single startActiveSpan callback the
  // way the other phases are -- it's opened here and closed wherever the
  // first token actually arrives (or, failing that, in the outer finally
  // below). ttftCtx is what anthropic-connect and message-start-insert
  // are created inside of, so they register as its children rather than
  // as siblings under the route's root span -- ttft *contains* both of
  // them, it isn't a third phase alongside them (confirmed against real
  // trace data on the clone: connect + insert account for essentially all
  // of the combined time-to-first-token duration).
  const ttftStartDate = Date.now();
  const ttftSpan = tracer.startSpan("time-to-first-token", {
    startTime: ttftStartDate,
  });
  const ttftCtx = trace.setSpan(context.active(), ttftSpan);
  let ttftEnded = false;
  function endTtft(endDate?: number) {
    if (!ttftEnded) {
      ttftEnded = true;
      ttftSpan.end(endDate);
    }
  }

  try {
    const anthropicResponse = await context.with(ttftCtx, () =>
      tracer.startActiveSpan("anthropic-connect", async (span) => {
        try {
          return await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: ANTHROPIC_MODEL,
              max_tokens: 1000,
              stream: true,
              messages: [{ role: "user", content: promptText }],
            }),
          });
        } finally {
          span.end();
        }
      }),
    );

    if (!anthropicResponse.ok || !anthropicResponse.body) {
      endTtft();
      // Anthropic's error responses are a JSON body describing exactly what
      // went wrong (bad/expired key, invalid_request_error for a bad
      // param, rate limit, etc.) -- read it now, while the response is
      // still available, so the real cause ends up in the thrown error's
      // own message rather than just a bare status code. Whatever this
      // throws is what the catch block below logs in full.
      const errorBody = await anthropicResponse
        .text()
        .catch(() => "<failed to read response body>");
      throw new Error(
        `Anthropic API request failed with status ${anthropicResponse.status}: ${errorBody}`,
      );
    }

    let resolvedModel: string | null = null;
    let accumulatedText = "";
    let responseRowId: string | null = null;
    // Seeded to "now" rather than 0, so the throttle genuinely applies to
    // the first delta too — otherwise Date.now() - 0 is always well past
    // the threshold and the very first delta bypasses it.
    let lastWriteAt = Date.now();
    let lastWrittenText = "";

    // Streaming-phase timing state — firstTokenAtDate marks the end of
    // time-to-first-token and the start of generation. The write
    // counters feed the throttled-writes span's attributes (a single
    // aggregated span, not one child span per write — at up to ~300
    // writes for one long response, per-write spans would be real
    // clutter in the waterfall for no diagnostic value beyond what
    // count/total/avg already give).
    let firstTokenAtDate: number | null = null;
    let firstWriteAtDate: number | null = null;
    let streamingWriteCount = 0;
    let streamingWriteTotalMs = 0;

    const reader = anthropicResponse.body.getReader();
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
            resolvedModel = message?.model ?? null;

            // The row a Realtime subscriber would attach to — created as
            // soon as we know the resolved model, before any content has
            // arrived. A child of time-to-first-token, not of
            // anthropic-connect (which has already ended by this point) —
            // both are ttft's own children, not nested under each other.
            const inserted = await context.with(ttftCtx, () =>
              tracer.startActiveSpan("message-start-insert", async (span) => {
                try {
                  const { data, error: insertError } = await supabase
                    .from("responses")
                    .insert({
                      discussion_id: discussionId,
                      user_id: user.id,
                      prompt_text: promptText,
                      response: null,
                      model: ANTHROPIC_MODEL,
                      resolved_model: resolvedModel,
                      cell_type: "assistant",
                    })
                    .select("id")
                    .single();
                  if (insertError) {
                    throw insertError;
                  }
                  return data;
                } finally {
                  span.end();
                }
              }),
            );
            responseRowId = inserted.id as string;
            break;
          }

          case "content_block_delta": {
            const delta = event.delta as
              { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              if (firstTokenAtDate === null) {
                firstTokenAtDate = Date.now();
                endTtft(firstTokenAtDate);
              }
              accumulatedText += delta.text;
            }

            const now = Date.now();
            if (
              responseRowId &&
              accumulatedText !== lastWrittenText &&
              now - lastWriteAt >= STREAM_WRITE_THROTTLE_MS
            ) {
              if (firstWriteAtDate === null) {
                firstWriteAtDate = now;
              }
              const writeStart = performance.now();
              const { error: updateError } = await supabase
                .from("responses")
                .update({ response: accumulatedText })
                .eq("id", responseRowId);
              streamingWriteCount += 1;
              streamingWriteTotalMs += performance.now() - writeStart;

              if (updateError) {
                throw updateError;
              }
              lastWriteAt = now;
              lastWrittenText = accumulatedText;
            }
            break;
          }

          case "message_stop": {
            // Safety net: only fires if no text_delta ever arrived (an
            // empty or entirely-non-text response), so ttft wasn't
            // already ended above.
            endTtft();

            // Retroactive span: both endpoints (firstTokenAtDate, now)
            // are already known by the time execution reaches here, so
            // this is created and ended in one step rather than kept
            // open across the loop the way time-to-first-token is.
            // Non-overlapping with time-to-first-token by construction:
            // measured from firstTokenAt to message_stop, same as the
            // original console.log-based mark this replaces.
            const generationEndDate = Date.now();
            tracer
              .startSpan("generation", {
                startTime: firstTokenAtDate ?? ttftStartDate,
              })
              .end(generationEndDate);

            // Aggregated span for every throttled UPDATE this response
            // made — see the comment above streamingWriteCount for why
            // this is one span with attributes rather than one span per
            // write.
            const writesSpan = tracer.startSpan(
              "throttled-writes",
              firstWriteAtDate !== null
                ? { startTime: firstWriteAtDate }
                : undefined,
            );
            writesSpan.setAttributes({
              "write.count": streamingWriteCount,
              "write.total_duration_ms": Number(
                streamingWriteTotalMs.toFixed(1),
              ),
              "write.avg_duration_ms":
                streamingWriteCount > 0
                  ? Number(
                      (streamingWriteTotalMs / streamingWriteCount).toFixed(1),
                    )
                  : 0,
            });
            writesSpan.end(
              firstWriteAtDate !== null ? generationEndDate : undefined,
            );

            await tracer.startActiveSpan("final-write", async (span) => {
              try {
                // Final write, unconditional on the throttle, so no
                // trailing partial batch is lost.
                if (!responseRowId) {
                  // Defensive fallback: message_start never arrived for
                  // some reason, so there's no row yet — create it now
                  // instead of silently dropping the content.
                  const { data: inserted, error: insertError } = await supabase
                    .from("responses")
                    .insert({
                      discussion_id: discussionId,
                      user_id: user.id,
                      prompt_text: promptText,
                      response: accumulatedText,
                      model: ANTHROPIC_MODEL,
                      resolved_model: resolvedModel,
                      cell_type: "assistant",
                    })
                    .select("id")
                    .single();
                  if (insertError) {
                    throw insertError;
                  }
                  responseRowId = inserted.id as string;
                } else if (accumulatedText !== lastWrittenText) {
                  const { error: updateError } = await supabase
                    .from("responses")
                    .update({ response: accumulatedText })
                    .eq("id", responseRowId);
                  if (updateError) {
                    throw updateError;
                  }
                }
              } finally {
                span.end();
              }
            });
            break;
          }

          default:
            break;
        }
      }
    }

    return Response.json({
      response: accumulatedText,
      resolved_model: resolvedModel,
    });
  } catch (error) {
    // The real cause (Anthropic error body, a Supabase error object, a
    // network failure, whatever it is) must always be logged in full here
    // -- this is the only place it's ever seen, and the user-facing
    // response below is deliberately generic, never the raw error. A
    // vague "Execution failed." with nothing logged turned a one-line
    // diagnosis into two rounds of hypothesis-testing once already; see
    // errorId below for matching a user's report back to this line.
    const errorId = crypto.randomUUID();
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    console.error(
      `[execute-error] id=${errorId} discussionId=${discussionId}: ${errorMessage}`,
      error instanceof Error ? error.stack : error,
    );
    return Response.json(
      {
        error:
          "Execution failed. Please try again or contact support if this persists.",
        errorId,
      },
      { status: 500 },
    );
  } finally {
    // Safety net: guarantees ttft is never left open if something threw
    // before either of the two normal end points (the error check right
    // after anthropic-connect, or the first text_delta) was reached.
    endTtft();
    await tracer.startActiveSpan("lock-release", async (span) => {
      try {
        await supabase.from("execution_locks").delete().eq("user_id", user.id);
      } finally {
        span.end();
      }
    });
  }
}

export const POST = withRouteErrorHandling(handlePost);
