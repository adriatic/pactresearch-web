// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

describe("withRouteErrorHandling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("converts a thrown error into a clean 500 without leaking details", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const handler = withRouteErrorHandling<[Request]>(async () => {
      throw new Error("some secret internal detail");
    });

    const response = await handler(
      new Request("http://localhost/api/whatever"),
    );
    const rawText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(rawText)).toEqual({ error: "Internal server error." });
    expect(rawText).not.toContain("secret internal detail");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  test("passes a normal response through completely unchanged", async () => {
    const originalResponse = Response.json({ ok: true }, { status: 201 });
    const handler = withRouteErrorHandling<[Request]>(
      async () => originalResponse,
    );

    const response = await handler(
      new Request("http://localhost/api/whatever"),
    );

    expect(response).toBe(originalResponse);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });
});
