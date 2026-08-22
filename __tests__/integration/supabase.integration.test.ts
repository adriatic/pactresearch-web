import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

describe("local Supabase wiring", () => {
  let supabase: SupabaseClient;

  beforeAll(async () => {
    // Wipe and re-apply migrations so every run starts from a known-clean local DB.
    // This is also the thing under test: reset must leave zero rows behind.
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    const { API_URL, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
    supabase = createClient(API_URL, SERVICE_ROLE_KEY);
  }, 30000);

  afterAll(async () => {
    await supabase
      .from("integration_test_probe")
      .delete()
      .not("id", "is", null);
  });

  test("reset leaves the probe table empty, then a row round-trips", async () => {
    const { data: initialRows, error: initialError } = await supabase
      .from("integration_test_probe")
      .select("*");

    expect(initialError).toBeNull();
    expect(initialRows).toHaveLength(0);

    const value = `probe-${Date.now()}`;
    const { data: inserted, error: insertError } = await supabase
      .from("integration_test_probe")
      .insert({ value })
      .select()
      .single();

    expect(insertError).toBeNull();
    expect(inserted?.value).toBe(value);

    const { data: readBack, error: readError } = await supabase
      .from("integration_test_probe")
      .select("*")
      .eq("id", inserted!.id)
      .single();

    expect(readError).toBeNull();
    expect(readBack?.value).toBe(value);
  });
});
