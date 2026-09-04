import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// Minimum time between UPDATEs to the responses row while content streams
// in. Anthropic's content_block_delta events can arrive many times a
// second — writing to Postgres on every single one would be wasteful and
// buys nothing, since no human (or Realtime-subscribed UI) can perceive
// updates faster than this anyway. 500ms is chosen the same way the
// execution_locks staleness threshold was: long enough to keep write
// volume reasonable even for a long, fast-streaming response (a ~10s
// generation lands around 20 writes, not hundreds), short enough that a
// Realtime subscriber watching the row still sees it grow live, well
// under the threshold of feeling laggy.
const STREAM_WRITE_THROTTLE_MS = 500;

interface ExecuteRequestBody {
  discussionId: string;
  promptText: string;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  const { data: acquired, error: lockError } = await supabase.rpc(
    "try_acquire_execution_lock",
    { p_user_id: user.id, p_discussion_id: discussionId },
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

  try {
    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
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

    if (!anthropicResponse.ok || !anthropicResponse.body) {
      throw new Error(
        `Anthropic API request failed with status ${anthropicResponse.status}`,
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
            // arrived.
            const { data: inserted, error: insertError } = await supabase
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
            responseRowId = inserted.id as string;
            break;
          }

          case "content_block_delta": {
            const delta = event.delta as
              { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              accumulatedText += delta.text;
            }

            const now = Date.now();
            if (
              responseRowId &&
              accumulatedText !== lastWrittenText &&
              now - lastWriteAt >= STREAM_WRITE_THROTTLE_MS
            ) {
              const { error: updateError } = await supabase
                .from("responses")
                .update({ response: accumulatedText })
                .eq("id", responseRowId);

              if (updateError) {
                throw updateError;
              }
              lastWriteAt = now;
              lastWrittenText = accumulatedText;
            }
            break;
          }

          case "message_stop": {
            // Final write, unconditional on the throttle, so no trailing
            // partial batch is lost.
            if (!responseRowId) {
              // Defensive fallback: message_start never arrived for some
              // reason, so there's no row yet — create it now instead of
              // silently dropping the content.
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
  } catch {
    return Response.json({ error: "Execution failed." }, { status: 500 });
  } finally {
    await supabase.from("execution_locks").delete().eq("user_id", user.id);
  }
}

export const POST = withRouteErrorHandling(handlePost);
