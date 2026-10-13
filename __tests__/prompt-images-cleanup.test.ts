import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { removePromptImagesForDiscussion } from "@/lib/promptImagesCleanup";

// Task 89. A fake bucket whose list() returns at most `limit` names, like
// Supabase Storage, so the cleanup has to come back for the rest.
function fakeStorage(count: number, opts: { removeNothing?: boolean } = {}) {
  let files = Array.from({ length: count }, (_, i) => `img-${i}.png`);
  const calls = { list: 0, remove: 0 };
  const bucket = {
    list: async (_prefix: string, o?: { limit?: number; offset?: number }) => {
      calls.list++;
      const offset = o?.offset ?? 0;
      const limit = o?.limit ?? 100;
      return {
        data: files.slice(offset, offset + limit).map((name) => ({ name })),
        error: null,
      };
    },
    remove: async (paths: string[]) => {
      calls.remove++;
      if (opts.removeNothing) return { data: [], error: null };
      const names = new Set(paths.map((p) => p.split("/").pop()));
      const removed = files.filter((f) => names.has(f));
      files = files.filter((f) => !names.has(f));
      return { data: removed.map((name) => ({ name })), error: null };
    },
  };
  const supabase = {
    storage: { from: () => bucket },
  } as unknown as SupabaseClient;
  return { supabase, calls, left: () => files.length };
}

describe("removePromptImagesForDiscussion", () => {
  it("removes every picture, in batches, when there are more than 100", async () => {
    const s = fakeStorage(250);
    await removePromptImagesForDiscussion(s.supabase, "u", "d");
    expect(s.left()).toBe(0);
    expect(s.calls.remove).toBe(3);
    expect(s.calls.list).toBe(4);
  });

  it("does nothing more when there are no pictures", async () => {
    const s = fakeStorage(0);
    await removePromptImagesForDiscussion(s.supabase, "u", "d");
    expect(s.calls.remove).toBe(0);
  });

  it("stops with an error, instead of looping, when listed pictures are not removed", async () => {
    const s = fakeStorage(5, { removeNothing: true });
    await expect(
      removePromptImagesForDiscussion(s.supabase, "u", "d"),
    ).rejects.toThrow(/none of 5 were removed/);
    expect(s.calls.remove).toBe(1);
  });
});
