import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const TEST_TABLE = "_test_probe";

interface LocalSupabaseStatus {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

function runLocalSql(sql: string): void {
  execFileSync("npx", ["supabase", "db", "query", "--local", sql], {
    stdio: "inherit",
  });
}

describe("local Supabase wiring", () => {
  let supabase: SupabaseClient;

  beforeAll(async () => {
    // Wipe and re-apply migrations so every run starts from a known-clean local DB.
    // This is also the thing under test: reset must leave zero rows behind.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    const { API_URL, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
    supabase = createClient(API_URL, SERVICE_ROLE_KEY);

    // Test-only table, created directly (not via supabase/migrations/, which
    // is shared with production db push) — underscore prefix marks it as
    // non-application schema at a glance.
    runLocalSql(
      `CREATE TABLE IF NOT EXISTS public.${TEST_TABLE} (` +
        `id uuid primary key default gen_random_uuid(), ` +
        `value text not null, ` +
        `created_at timestamptz not null default now());`,
    );
    runLocalSql(`ALTER TABLE public.${TEST_TABLE} ENABLE ROW LEVEL SECURITY;`);
    runLocalSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${TEST_TABLE} TO service_role;`,
    );
  }, 45000);

  afterAll(async () => {
    runLocalSql(`DROP TABLE IF EXISTS public.${TEST_TABLE};`);
  });

  test("reset leaves the probe table empty, then a row round-trips", async () => {
    const { data: initialRows, error: initialError } = await supabase
      .from(TEST_TABLE)
      .select("*");

    expect(initialError).toBeNull();
    expect(initialRows).toHaveLength(0);

    const value = `probe-${Date.now()}`;
    const { data: inserted, error: insertError } = await supabase
      .from(TEST_TABLE)
      .insert({ value })
      .select()
      .single();

    expect(insertError).toBeNull();
    expect(inserted?.value).toBe(value);

    const { data: readBack, error: readError } = await supabase
      .from(TEST_TABLE)
      .select("*")
      .eq("id", inserted!.id)
      .single();

    expect(readError).toBeNull();
    expect(readBack?.value).toBe(value);
  });
});
