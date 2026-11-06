import { expect, type BrowserContext, type Page } from "@playwright/test";
import { seedSignedIn, type Seeded } from "./themeHelpers";

// Task D13. Local seeded data for the Compare page specs. Not a .spec.ts
// file, so Playwright does not collect it as a test.
//
// User 1 (signed in): notebook 1 with one discussion of four answers,
// notebook 2 with one answer. User 2 (never signed in): one answer.

export const TEXT = {
  // The diff-tests lab's own sample texts.
  first: `Use a central execution engine with provider adapters.
Stream tokens through a shared event bus.
A retry creates a new execution cell.
Abort the provider request when Stop is pressed.`,
  second: `Use a central execution engine with model adapters.
Stream tokens through a shared event bus.
A retry creates a new execution cell.
Abort the provider request when Stop is pressed.`,
  // The lab's JSON sample, A side.
  json: '{"model":"gpt-4.1","stream":false,"retry":1,"config":{"timeout":30}}',
  fourth: `Use a central orchestrator with model adapters.
Stream provider deltas through a normalized event interface.
A retry creates a new attempt within the same cell.
Mark a run as cancelling and wait for confirmation.`,
  // The lab's JSON sample, B side (in notebook 2).
  otherNotebook:
    '{"model":"gpt-6","stream":true,"retry":3,"config":{"timeout":30}}',
};

// Gives the semantic engine every kind of finding but "conflict" (which
// the JSON engine gives): a polarity difference, an agreement, and a
// statement only in each text.
export const SEMANTIC = {
  a: "Enable the cache for every request.\nLogs are kept for seven days.\nZebras graze quietly beyond distant hills.",
  b: "Do not enable the cache for every request.\nLogs are kept for seven days.\nMetrics go to the dashboard.",
};

export interface CompareSeed extends Seeded {
  /** User 1's answers: four in the first discussion, then notebook 2's. */
  answers: string[];
  otherNotebookName: string;
  otherDiscussionName: string;
  /** User 2's answer id. */
  strangerAnswer: string;
}

async function addAnswer(
  seeded: Pick<Seeded, "admin" | "userId">,
  discussionId: string,
  n: number,
  response: string,
  model = "claude-sonnet-5",
): Promise<string> {
  const { data, error } = await seeded.admin
    .from("responses")
    .insert({
      discussion_id: discussionId,
      user_id: seeded.userId,
      prompt_text: `Prompt for answer ${n}`,
      response,
      model,
      resolved_model: model,
      cell_type: "assistant",
      created_at: new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("no response row");
  return data.id as string;
}

/** User 1 signed in with the five answers above; user 2 with one answer. */
export async function seedCompare(
  context: BrowserContext,
  tag: string,
  texts: string[] = [TEXT.first, TEXT.second, TEXT.json, TEXT.fourth],
): Promise<CompareSeed> {
  const seeded = await seedSignedIn(context, { tag });
  const answers: string[] = [];
  for (const [i, text] of texts.entries()) {
    answers.push(
      await addAnswer(
        seeded,
        seeded.discussionId,
        i + 1,
        text,
        i === 3 ? "gpt-6.1-sol" : "claude-sonnet-5",
      ),
    );
  }

  const otherNotebookName = `E2E ${tag} second notebook`;
  const otherDiscussionName = `E2E ${tag} second discussion`;
  const { data: notebook } = await seeded.admin
    .from("notebooks")
    .insert({ user_id: seeded.userId, name: otherNotebookName })
    .select()
    .single();
  const { data: discussion } = await seeded.admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: seeded.userId,
      name: otherDiscussionName,
    })
    .select()
    .single();
  answers.push(await addAnswer(seeded, discussion!.id, 1, TEXT.otherNotebook));

  // User 2: a separate account, never signed in here.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data: created, error } = await seeded.admin.auth.admin.createUser({
    email: `e2e-${tag}-stranger-${suffix}@example.com`,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no second user");
  const stranger = { admin: seeded.admin, userId: created.user.id };
  const { data: strangerNotebook } = await seeded.admin
    .from("notebooks")
    .insert({ user_id: stranger.userId, name: `E2E ${tag} stranger notebook` })
    .select()
    .single();
  const { data: strangerDiscussion } = await seeded.admin
    .from("discussions")
    .insert({
      notebook_id: strangerNotebook!.id,
      user_id: stranger.userId,
      name: `E2E ${tag} stranger discussion`,
    })
    .select()
    .single();
  const strangerAnswer = await addAnswer(
    stranger,
    strangerDiscussion!.id,
    1,
    "Another user's answer, never shown to user 1.",
  );

  return {
    ...seeded,
    answers,
    otherNotebookName,
    otherDiscussionName,
    strangerAnswer,
  };
}

/** Opens /compare for two answers and waits for the comparison. */
export async function openComparison(
  page: Page,
  a: string,
  b: string,
  engine?: string,
) {
  const query = new URLSearchParams({ a, b });
  if (engine) query.set("engine", engine);
  await page.goto(`/compare?${query}`);
  await expect(page.getByRole("region", { name: "Comparison" })).toBeVisible({
    timeout: 15_000,
  });
}

export const pickerA = (page: Page) =>
  page.getByLabel("Answer A", { exact: true });
export const pickerB = (page: Page) =>
  page.getByLabel("Answer B", { exact: true });
export const engineSelect = (page: Page) =>
  page.getByLabel("Engine", { exact: true });
