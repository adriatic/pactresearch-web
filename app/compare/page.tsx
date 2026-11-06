import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import {
  findAnswer,
  groupAnswers,
  isResponseId,
  parseCompareParams,
  type AnswerGroup,
  type AnswerRow,
  type DiscussionRow,
  type NotebookRow,
} from "@/lib/diff/compareAnswers";
import { CompareView, type CompareSide } from "./CompareView";

// Task D13. Compares two stored answers with the diff engines from D12
// (lib/diff/engines.ts). Reached by its address only for now:
// /compare?a=<responseId>&b=<responseId>[&engine=line]. The entry point
// from the workspace comes in D14, the Meaning engine in D15.
//
// Signed out goes to /login, as on the workspace. Everything is read with
// the session client, so row-level security keeps each user to their own
// notebooks, discussions and answers: another user's answer id is
// indistinguishable from one that does not exist, and both show
// "Response not found".

export const metadata: Metadata = { title: "Compare answers · PACT" };

// PostgREST returns at most max_rows (1000, supabase/config.toml) rows per
// request; a long-time user can have more answers than that.
const PAGE = 1000;

async function readAll<T>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: unknown;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await load(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function loadSide(
  supabase: SupabaseClient,
  groups: AnswerGroup[],
  id: string | null,
): Promise<CompareSide> {
  if (id === null) return { state: "none" };
  if (!isResponseId(id)) return { state: "not-found" };
  const place = findAnswer(groups, id);
  if (!place) return { state: "not-found" };
  const { data, error } = await supabase
    .from("responses")
    .select("id, prompt_text, response")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { state: "not-found" };
  return {
    state: "found",
    id,
    number: place.answer.number,
    label: place.answer.label,
    createdAt: place.answer.createdAt,
    notebookName: place.group.notebookName,
    discussionName: place.group.discussionName,
    promptText: data.prompt_text ?? "",
    text: data.response ?? "",
  };
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { a, b, engine } = parseCompareParams(await searchParams);

  const [notebooks, discussions, answers] = await Promise.all([
    readAll<NotebookRow>((from, to) =>
      supabase
        .from("notebooks")
        .select("id, name, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAll<DiscussionRow>((from, to) =>
      supabase
        .from("discussions")
        .select("id, name, notebook_id, created_at")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAll<AnswerRow>((from, to) =>
      supabase
        .from("responses")
        .select("id, discussion_id, created_at, model, resolved_model")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  const groups = groupAnswers(notebooks, discussions, answers);

  const [sideA, sideB] = await Promise.all([
    loadSide(supabase, groups, a),
    loadSide(supabase, groups, b),
  ]);

  return (
    <CompareView
      groups={groups}
      a={sideA}
      b={sideB}
      requested={{ a, b }}
      engineId={engine}
    />
  );
}
