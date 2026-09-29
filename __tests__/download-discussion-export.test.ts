// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadDiscussionExport } from "@/lib/downloadDiscussionExport";

// Task 65 follow-up. This helper is what the Explorer's row menu and
// the active-discussion header's Export button now share, so a bug here
// is a bug in both. jsdom has no object-URL implementation, hence the
// stubs; everything else is the real code path.

let clicked: HTMLAnchorElement[] = [];
let created: Blob[] = [];
let revoked: string[] = [];

beforeEach(() => {
  clicked = [];
  created = [];
  revoked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:fake/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function respondWith(body: unknown, ok = true) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("a successful export", () => {
  beforeEach(() => {
    respondWith({
      filename: "Simple-pendulum-2026-09-29.md",
      markdown: "# Simple pendulum\n",
    });
  });

  test("asks the per-discussion endpoint for that id", async () => {
    await downloadDiscussionExport("abc-123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/discussions/export?id=abc-123",
    );
  });

  test("an id needing escaping is encoded, not concatenated raw", async () => {
    await downloadDiscussionExport("a b&c=d");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/discussions/export?id=a%20b%26c%3Dd",
    );
  });

  // The filename convention lives on the server so both callers get the
  // same one. This asserts the client does not second-guess it.
  test("the download uses the server's filename verbatim", async () => {
    expect(await downloadDiscussionExport("abc-123")).toBe(true);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("Simple-pendulum-2026-09-29.md");
  });

  test("the blob is markdown, and carries the markdown", async () => {
    await downloadDiscussionExport("abc-123");
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("text/markdown;charset=utf-8");
    await expect(created[0].text()).resolves.toBe("# Simple pendulum\n");
  });

  // A leaked anchor or object URL per export is the kind of thing that
  // only shows up after someone exports fifty times.
  test("it cleans up after itself", async () => {
    await downloadDiscussionExport("abc-123");
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(revoked).toEqual(["blob:fake/1"]);
  });
});

describe("failures are reported, not thrown", () => {
  test("a non-ok response returns false and downloads nothing", async () => {
    respondWith({ error: "Discussion not found." }, false);
    expect(await downloadDiscussionExport("gone")).toBe(false);
    expect(clicked).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  // Both callers show their own inline message; an unhandled rejection
  // would instead show nothing at all.
  test("a network error returns false rather than rejecting", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(downloadDiscussionExport("abc")).resolves.toBe(false);
  });

  test("a malformed body returns false rather than rejecting", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    await expect(downloadDiscussionExport("abc")).resolves.toBe(false);
  });
});
