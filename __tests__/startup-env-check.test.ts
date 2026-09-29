import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Task 66. The second of the two checks: the one that runs when a
// server instance boots. next.config.ts is the gate that stops a broken
// deploy going live; this one covers `next start` against an
// environment the build never inspected.
vi.mock("@vercel/otel", () => ({ registerOTel: vi.fn() }));

const { register } = await import("@/instrumentation");

const GOOD_SECRET = Buffer.alloc(32, 7).toString("base64");

let errors: string[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fake.anon.key";
  process.env.API_KEY_ENCRYPTION_SECRET = GOOD_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("register()", () => {
  test("says nothing when the environment is complete", () => {
    register();
    expect(errors).toEqual([]);
  });

  test("names the missing variable in the startup log", () => {
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    register();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("STARTUP ENVIRONMENT CHECK FAILED");
    expect(errors[0]).toContain(
      "Missing required environment variable: API_KEY_ENCRYPTION_SECRET",
    );
  });

  test("catches a present-but-unusable value too", () => {
    process.env.API_KEY_ENCRYPTION_SECRET = Buffer.alloc(8, 1).toString(
      "base64",
    );
    register();
    expect(errors[0]).toContain("API_KEY_ENCRYPTION_SECRET");
    expect(errors[0]).toContain("got 8");
  });

  // Deliberate: throwing here would stop the instance serving anything,
  // turning "one feature is broken" into "the whole site is down" --
  // a bigger outage than the one this task exists to prevent. The build
  // gate is what refuses to ship; this one refuses to be silent.
  test("does not throw -- it reports and lets the instance serve", () => {
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "API_KEY_ENCRYPTION_SECRET",
    ]) {
      delete process.env[name];
    }
    expect(() => register()).not.toThrow();
    expect(errors[0]).toContain("STARTUP ENVIRONMENT CHECK FAILED");
  });

  test("the startup log never quotes the value", () => {
    const secret = Buffer.alloc(8, 3).toString("base64");
    process.env.API_KEY_ENCRYPTION_SECRET = secret;
    register();
    expect(errors[0]).not.toContain(secret);
  });
});
