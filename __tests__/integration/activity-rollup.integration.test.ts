import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient,
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { getDiscussionRollup, getNotebookRollup } from "@/lib/activityRollup";

// Task 55b part 2. The derived rollups, against a real database.
//
// Queried through a USER-SCOPED client (anon key + a real sign-in) rather
// than the service role, so RLS applies exactly as it will in the app. A
// rollup that only works for a service role would be useless.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as LocalSupabaseStatus;
}

describe("activity rollups", () => {
  let admin: SupabaseClient;
  let asUser: SupabaseClient;
  let userId: string;
  let notebookId: string;
  let emptyDiscussionId: string;
  let busyDiscussionId: string;
  let quietDiscussionId: string;

  // Deliberately uneven so a sum cannot accidentally look right.
  const BUSY_RUN_MS = [1200, 3400, 250];
  const QUIET_RUN_MS = [900];

  beforeAll(async () => {
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });
    const status = getLocalSupabaseStatus();
    admin = createServiceClient(status.API_URL, status.SERVICE_ROLE_KEY);

    const email = `rollup-${Date.now()}@example.com`;
    const password = "correct horse battery staple 13!";
    const { data: created, error: userError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (userError || !created.user) throw userError ?? new Error("no user");
    userId = created.user.id;

    asUser = createClient(status.API_URL, status.ANON_KEY);
    const { error: signInError } = await asUser.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    const { data: notebook } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "Rollup notebook" })
      .select()
      .single();
    notebookId = notebook!.id;

    async function seedDiscussion(name: string, runMs: number[]) {
      const { data: discussion } = await admin
        .from("discussions")
        .insert({
          notebook_id: notebookId,
          user_id: userId,
          name,
          // What part 1 would have accumulated for these runs.
          total_time_ms: runMs.reduce((a, b) => a + b, 0),
        })
        .select()
        .single();
      for (const ms of runMs) {
        await admin.from("execution_timings").insert({
          user_id: userId,
          discussion_id: discussion!.id,
          total_ms: ms,
        });
        await admin.from("responses").insert({
          discussion_id: discussion!.id,
          user_id: userId,
          prompt_text: `prompt for ${ms}`,
          response: "a response",
          model: "m",
          resolved_model: "m",
        });
      }
      return discussion!.id as string;
    }

    emptyDiscussionId = await seedDiscussion("Empty discussion", []);
    busyDiscussionId = await seedDiscussion("Busy discussion", BUSY_RUN_MS);
    quietDiscussionId = await seedDiscussion("Quiet discussion", QUIET_RUN_MS);
  }, 120000);

  test("a discussion with zero runs reports zero, not null or a broken span", async () => {
    const rollup = await getDiscussionRollup(asUser, emptyDiscussionId);
    expect(rollup).not.toBeNull();
    expect(rollup!.totalTimeMs).toBe(0);
    expect(rollup!.runCount).toBe(0);
    // Falls back to the discussion's own creation time rather than null,
    // so a caller never has to render "no data" for a real discussion.
    expect(rollup!.firstActivity).not.toBeNull();
    expect(rollup!.lastActivity).not.toBeNull();
    expect(rollup!.firstActivity).toBe(rollup!.lastActivity);
  });

  test("a discussion with several runs sums them and spans the right window", async () => {
    const rollup = await getDiscussionRollup(asUser, busyDiscussionId);
    expect(rollup!.totalTimeMs).toBe(BUSY_RUN_MS.reduce((a, b) => a + b, 0));
    expect(rollup!.runCount).toBe(BUSY_RUN_MS.length);
    expect(new Date(rollup!.lastActivity!).getTime()).toBeGreaterThanOrEqual(
      new Date(rollup!.firstActivity!).getTime(),
    );
  });

  test("run count counts RUNS, which is not the same as responses", async () => {
    // A run that produced nothing still gets a timing row -- in
    // production, 24 timing rows against 13 responses. The rollup must
    // report runs, and a caller must not label it "responses".
    await admin.from("execution_timings").insert({
      user_id: userId,
      discussion_id: quietDiscussionId,
      total_ms: 500,
    });

    const rollup = await getDiscussionRollup(asUser, quietDiscussionId);
    const { count: responseCount } = await admin
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("discussion_id", quietDiscussionId);

    expect(rollup!.runCount).toBe(QUIET_RUN_MS.length + 1);
    expect(rollup!.runCount).toBeGreaterThan(responseCount ?? 0);
  });

  test("the notebook total equals its discussions added up by hand", async () => {
    const notebook = await getNotebookRollup(asUser, notebookId);

    const perDiscussion = await Promise.all(
      [emptyDiscussionId, busyDiscussionId, quietDiscussionId].map((id) =>
        getDiscussionRollup(asUser, id),
      ),
    );
    const manualTotal = perDiscussion.reduce(
      (sum, r) => sum + r!.totalTimeMs,
      0,
    );
    const manualRuns = perDiscussion.reduce((sum, r) => sum + r!.runCount, 0);

    expect(notebook!.totalTimeMs).toBe(manualTotal);
    expect(notebook!.runCount).toBe(manualRuns);

    // And against the raw numbers, so this cannot pass by both sides
    // sharing the same bug.
    expect(notebook!.totalTimeMs).toBe(
      [...BUSY_RUN_MS, ...QUIET_RUN_MS].reduce((a, b) => a + b, 0),
    );

    // The notebook span covers all of its discussions.
    const earliest = Math.min(
      ...perDiscussion.map((r) => new Date(r!.firstActivity!).getTime()),
    );
    const latest = Math.max(
      ...perDiscussion.map((r) => new Date(r!.lastActivity!).getTime()),
    );
    expect(new Date(notebook!.firstActivity!).getTime()).toBeLessThanOrEqual(
      earliest,
    );
    expect(new Date(notebook!.lastActivity!).getTime()).toBe(latest);
  });

  test("an unknown id returns null rather than an empty-looking rollup", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(await getDiscussionRollup(asUser, missing)).toBeNull();
    expect(await getNotebookRollup(asUser, missing)).toBeNull();
  });
});
