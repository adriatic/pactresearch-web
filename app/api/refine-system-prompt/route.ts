import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { modelForTier } from "@/lib/modelTiers";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Task 50 item B. "Refine with AI": the user describes their research
// domain and Claude drafts a system prompt for that notebook.
//
// Non-streaming and capped deliberately -- a system prompt is short, the
// user is staring at a modal waiting for one field to fill in, and there
// is no live preview to feed. Uses the same key and the same per-user
// model tier as /api/execute, so a user on Economy drafts with Economy.
const MAX_TOKENS = 1024;

// Kept tight on purpose. The output goes straight into an editable
// textarea, so anything conversational ("Here's a system prompt for
// you!") would have to be deleted by hand before saving.
const DRAFTING_SYSTEM_PROMPT = `You write system prompts for a research notebook tool.

The user will describe their research domain. Write a system prompt that
instructs an assistant how to help with that domain: what expertise to
bring, what to prioritise, what to be careful about.

Rules:
- Output ONLY the system prompt itself. No preamble, no explanation, no
  surrounding quotes, no markdown code fence.
- Address the assistant in the second person ("You are...", "You should...").
- Be specific to the described domain rather than generically helpful.
- Keep it under 200 words.`;

async function handlePost(request: Request): Promise<Response> {
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

  const body = (await request.json()) as { description?: unknown };
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return Response.json(
      { error: "Describe your research domain first." },
      { status: 400 },
    );
  }
  // A system prompt is drafted from a sentence or two; anything longer is
  // a paste accident, and it would be billed.
  if (description.length > 2000) {
    return Response.json(
      { error: "That description is too long — a sentence or two is plenty." },
      { status: 400 },
    );
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelForTier(user.user_metadata?.model_tier),
      max_tokens: MAX_TOKENS,
      system: DRAFTING_SYSTEM_PROMPT,
      messages: [{ role: "user", content: description }],
    }),
  });

  if (!response.ok) {
    // Same reasoning as /api/execute's error path: log the real cause,
    // return something generic. An upstream error body can carry account
    // and key details that do not belong in a browser.
    const errorId = crypto.randomUUID();
    console.error(
      `[refine-system-prompt-error] id=${errorId} status=${response.status}: ${await response.text()}`,
    );
    return Response.json(
      {
        error: "Couldn't draft a system prompt. Please try again.",
        errorId,
      },
      { status: 502 },
    );
  }

  const message = (await response.json()) as {
    content?: { type?: string; text?: string }[];
  };
  const systemPrompt = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  if (!systemPrompt) {
    return Response.json(
      { error: "The model returned nothing. Please try again." },
      { status: 502 },
    );
  }

  return Response.json({ systemPrompt });
}

export const POST = withRouteErrorHandling(handlePost);
