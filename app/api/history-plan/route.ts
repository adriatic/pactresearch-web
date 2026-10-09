import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import { modelForTier } from "@/lib/modelTiers";
import {
  FALLBACK_MAX_TOKENS,
  parseContextChoice,
  planHistory,
  promptDocBlocksForEstimate,
  roughNumber,
  shouldShowHint,
  sizeWord,
  type PlanTurn,
} from "@/lib/historyPlan";
import type { RichContent } from "@/lib/richContent";
import type { AnthropicContentBlock } from "@/lib/promptContentToAnthropicBlocks";

// Task 71 Stage 2. What the next question would send, for the hint under
// the prompt box: how many earlier turns and pictures, and a rough size.
//
// It reads the same inputs the run reads (the user's model tier, the
// max_tokens setting, the notebook's system prompt, the discussion's
// turns) and passes them to the same planHistory the run builds its
// request from, so the hint and the request cannot disagree. It sends
// nothing to the model and changes nothing.

interface PlanRequestBody {
  discussionId?: unknown;
  promptContent?: unknown;
  context?: unknown;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PlanRequestBody;
  try {
    body = (await request.json()) as PlanRequestBody;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }
  const choice = parseContextChoice(body.context);
  if (typeof body.discussionId !== "string" || choice === null) {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }
  const discussionId = body.discussionId;
  const promptContent =
    body.promptContent && typeof body.promptContent === "object"
      ? (body.promptContent as RichContent)
      : null;

  const [{ data: settings }, { data: discussionRow }, turnsResult] =
    await Promise.all([
      supabase
        .from("app_settings")
        .select("max_tokens")
        .eq("id", 1)
        .maybeSingle(),
      supabase
        .from("discussions")
        .select("notebooks(system_prompt)")
        .eq("id", discussionId)
        .maybeSingle(),
      supabase
        .from("responses")
        .select("id, prompt_text, prompt_content, response, created_at")
        .eq("discussion_id", discussionId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ]);
  if (turnsResult.error) throw turnsResult.error;

  const notebook = discussionRow?.notebooks as
    { system_prompt: string | null } | null | undefined;
  const systemPrompt = notebook?.system_prompt?.trim() || null;

  let currentPrompt: AnthropicContentBlock[];
  try {
    currentPrompt = promptDocBlocksForEstimate(promptContent);
  } catch {
    // A half-typed document the schema cannot read yet: estimate the
    // history without it rather than failing the hint.
    currentPrompt = [];
  }

  const plan = planHistory({
    turns: (turnsResult.data ?? []) as PlanTurn[],
    choice,
    model: modelForTier(user.user_metadata?.model_tier),
    maxTokens: settings?.max_tokens ?? FALLBACK_MAX_TOKENS,
    systemPrompt,
    currentPrompt,
  });

  return Response.json({
    totalTurns: plan.totalTurns,
    turnsSent: plan.kept.length,
    turnIdsSent: plan.kept.map((t) => t.id),
    leftOutByChoice: plan.leftOutByChoice,
    leftOutByCap: plan.leftOutByCap,
    picturesInHistory: plan.picturesInHistory,
    picturesSent: plan.picturesSent,
    estimatedTokens: plan.estimatedTokens,
    sizeWord: sizeWord(plan.estimatedTokens),
    roughSize: roughNumber(plan.estimatedTokens),
    showHint: shouldShowHint(plan, choice !== undefined),
  });
}

export const POST = withRouteErrorHandling(handlePost);
