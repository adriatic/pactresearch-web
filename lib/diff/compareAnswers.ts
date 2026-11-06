// Task D13. Helpers for the Compare page (/compare): grouping a user's
// stored answers for the two pickers, numbering them the way a
// discussion shows them, the page address, and the length limits that
// keep a slow engine from freezing the page. Pure functions: no app
// code, no database, no environment.

import { responseLlmLabel } from "@/lib/llmProviders";
import { findEngine } from "@/lib/diff/engines";
import { MEANING_MAX_CHARS } from "@/lib/diff/meaning";

export interface NotebookRow {
  id: string;
  name: string;
  created_at: string;
}

export interface DiscussionRow {
  id: string;
  name: string;
  notebook_id: string;
  created_at: string;
}

/** One stored answer, without its text (the pickers need only this). */
export interface AnswerRow {
  id: string;
  discussion_id: string;
  created_at: string;
  model: string | null;
  resolved_model: string | null;
}

/** One entry in a picker: "answer 2", its model label and when it was made. */
export interface AnswerOption {
  id: string;
  number: number;
  label: string;
  createdAt: string;
}

/** The answers of one discussion, under its notebook's and discussion's names. */
export interface AnswerGroup {
  notebookId: string;
  notebookName: string;
  discussionId: string;
  discussionName: string;
  answers: AnswerOption[];
}

const byCreated = <T extends { created_at: string; id: string }>(x: T, y: T) =>
  x.created_at < y.created_at
    ? -1
    : x.created_at > y.created_at
      ? 1
      : x.id < y.id
        ? -1
        : x.id > y.id
          ? 1
          : 0;

/**
 * The pickers' list. Notebooks newest first and discussions oldest first,
 * as the Explorer shows them; each discussion's answers in the order they
 * were made, numbered from 1 ("answer 1, answer 2, ..."). A discussion
 * with no answers is left out.
 */
export function groupAnswers(
  notebooks: NotebookRow[],
  discussions: DiscussionRow[],
  answers: AnswerRow[],
): AnswerGroup[] {
  const answersByDiscussion = new Map<string, AnswerRow[]>();
  for (const a of answers) {
    const list = answersByDiscussion.get(a.discussion_id) ?? [];
    list.push(a);
    answersByDiscussion.set(a.discussion_id, list);
  }
  const groups: AnswerGroup[] = [];
  const notebooksNewestFirst = [...notebooks].sort((x, y) => byCreated(y, x));
  for (const notebook of notebooksNewestFirst) {
    const own = discussions
      .filter((d) => d.notebook_id === notebook.id)
      .sort(byCreated);
    for (const discussion of own) {
      const rows = (answersByDiscussion.get(discussion.id) ?? []).sort(
        byCreated,
      );
      if (rows.length === 0) continue;
      groups.push({
        notebookId: notebook.id,
        notebookName: notebook.name,
        discussionId: discussion.id,
        discussionName: discussion.name,
        answers: rows.map((row, i) => ({
          id: row.id,
          number: i + 1,
          label: responseLlmLabel(row),
          createdAt: row.created_at,
        })),
      });
    }
  }
  return groups;
}

/** Where an answer sits: its group and its entry, or null if it is not in the list. */
export function findAnswer(
  groups: AnswerGroup[],
  id: string,
): { group: AnswerGroup; answer: AnswerOption } | null {
  for (const group of groups) {
    const answer = group.answers.find((a) => a.id === id);
    if (answer) return { group, answer };
  }
  return null;
}

/** The text of one picker entry: "answer 2 · Claude · claude-sonnet-5 · 5 Nov, 14:03". */
export function answerOptionText(
  answer: AnswerOption,
  formatDate: (iso: string) => string,
): string {
  const when = formatDate(answer.createdAt);
  return [`answer ${answer.number}`, answer.label, when]
    .filter(Boolean)
    .join(" · ");
}

/** The picker group heading: "Notebook › Discussion". */
export function groupHeading(group: AnswerGroup): string {
  return `${group.notebookName} › ${group.discussionName}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed id; anything else can only be "not found". */
export function isResponseId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

type SearchParams = { [key: string]: string | string[] | undefined };

const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/** What the address asks for. An id is kept as given (it may be "not found"); the engine falls back to Word diff. */
export function parseCompareParams(params: SearchParams): {
  a: string | null;
  b: string | null;
  engine: string;
} {
  const a = first(params.a)?.trim() || null;
  const b = first(params.b)?.trim() || null;
  const engine = findEngine(first(params.engine) ?? "").id;
  return { a, b, engine };
}

/** The page address for a choice, so it can be reloaded and linked. */
export function compareHref(choice: {
  a: string | null;
  b: string | null;
  engine?: string | null;
}): string {
  const params = new URLSearchParams();
  if (choice.a) params.set("a", choice.a);
  if (choice.b) params.set("b", choice.b);
  if (choice.engine && choice.engine !== "word")
    params.set("engine", choice.engine);
  const query = params.toString();
  return query ? `/compare?${query}` : "/compare";
}

/**
 * Engines that slow down sharply on long, very different texts, with the
 * most characters (both texts together) they are run on. Measured on a
 * Mac with dissimilar text (D12 and D13 reports): Character diff 2.1 s at
 * 20,000 characters and 55 s at 80,000; Word diff 2.5 s at 87,000 and
 * 10 s at 173,000. Line, JSON and semantic stay under about a second.
 */
export const ENGINE_TEXT_LIMITS: Readonly<Record<string, number>> = {
  character: 20_000,
  word: 80_000,
  // Task D15: the Meaning engine's limit, the lab's, for the two together.
  meaning: MEANING_MAX_CHARS,
};

const WHAT_TO_DO: Readonly<Record<string, string>> = {
  character: "Use Word diff or Line diff.",
  word: "Use Line diff.",
  meaning: "Meaning cannot run on them; use another engine.",
};

/** A plain message when the two texts are too long for this engine, otherwise null. */
export function tooLongMessage(
  engineId: string,
  a: string,
  b: string,
): string | null {
  const limit = ENGINE_TEXT_LIMITS[engineId];
  const total = a.length + b.length;
  if (limit === undefined || total <= limit) return null;
  const label = findEngine(engineId).label;
  return (
    `These two answers are too long for ${label}: ` +
    `${total.toLocaleString("en-US")} characters together, ` +
    `and ${label} runs on up to ${limit.toLocaleString("en-US")}. ` +
    WHAT_TO_DO[engineId]
  );
}
