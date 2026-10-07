import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  importPactFiles,
  isOlderSignedFormat,
  pickPactFiles,
  PICKER_OPTIONS,
  REASONS,
  summarizeImport,
  supportsOpenFilePicker,
  type PostImport,
} from "@/lib/pactImport";
import { ImportStatus } from "@/app/ImportStatus";

// Task 79: several .pact files at once, a plain summary, and the newer
// file chooser where the browser has it.

afterEach(cleanup);

const GOOD = JSON.stringify({
  version: 1,
  exportedAt: 1,
  notebook: { name: "Good", systemPrompt: null },
  discussions: [],
  cells: [],
});
const SIGNED = JSON.stringify({
  version: 1,
  payload: {},
  signature: "x",
  signer: "pact-local",
});
const file = (name: string, text: string) => new File([text], name);

// Stands in for the import route: accepts the GOOD shape, refuses the rest
// the way the real route does.
const route: PostImport = async (parsed) => {
  const p = parsed as Record<string, unknown>;
  if (p && typeof p === "object" && "notebook" in p) {
    return { status: 201, body: { name: "Good" } };
  }
  if (p && typeof p === "object" && "payload" in p) {
    return {
      status: 400,
      body: { error: "Not a valid .pact file: missing notebook object." },
    };
  }
  return {
    status: 400,
    body: {
      error: "Unsupported .pact file version: expected 1, got undefined.",
    },
  };
};

describe("importing several files", () => {
  test("all good: every file imports, in order, with progress", async () => {
    const progress: string[] = [];
    const out = await importPactFiles(
      [file("a.pact", GOOD), file("b.pact", GOOD), file("c.pact", GOOD)],
      route,
      (done, total) => progress.push(`${done}/${total}`),
    );
    expect(out.map((o) => o.ok)).toEqual([true, true, true]);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(summarizeImport(out)).toEqual({
      headline: "Imported 3 files.",
      problems: [],
    });
  });

  test("one bad file never stops the rest", async () => {
    const post = vi.fn(route);
    const out = await importPactFiles(
      [
        file("a.pact", GOOD),
        file("broken.pact", '{"cut'),
        file("c.pact", GOOD),
      ],
      post,
    );
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(post).toHaveBeenCalledTimes(2); // the damaged file never reaches the route
    expect(summarizeImport(out)).toEqual({
      headline: "Imported 2 of 3 files.",
      problems: [{ file: "broken.pact", reason: REASONS.damaged }],
    });
  });

  test("all bad: each gets its own plain reason", async () => {
    const out = await importPactFiles(
      [
        file("old.pact", SIGNED),
        file("broken.pact", "{"),
        file("other.pact", '{"hello":"world"}'),
        file("photo.png", "x"),
      ],
      route,
      undefined,
      { requirePactName: true },
    );
    expect(summarizeImport(out)).toEqual({
      headline: "None of the 4 files could be imported.",
      problems: [
        { file: "old.pact", reason: REASONS.olderFormat },
        { file: "broken.pact", reason: REASONS.damaged },
        { file: "other.pact", reason: REASONS.notNotebook },
        { file: "photo.png", reason: REASONS.notPact },
      ],
    });
  });

  test("server failure, signed out and no connection read plainly", async () => {
    const out = await importPactFiles(
      [file("a.pact", GOOD), file("b.pact", GOOD), file("c.pact", GOOD)],
      vi
        .fn<PostImport>()
        .mockResolvedValueOnce({
          status: 500,
          body: { error: "Internal server error." },
        })
        .mockResolvedValueOnce({ status: 401, body: { error: "Unauthorized" } })
        .mockRejectedValueOnce(new TypeError("Failed to fetch")),
    );
    expect(out.map((o) => (o.ok ? "ok" : o.reason))).toEqual([
      REASONS.serverFailed,
      REASONS.signedOut,
      REASONS.unreachable,
    ]);
  });

  test("a single file reads naturally", () => {
    expect(
      summarizeImport([{ file: "x.pact", ok: false, reason: REASONS.damaged }])
        .headline,
    ).toBe("The file could not be imported.");
    expect(
      summarizeImport([{ file: "x.pact", ok: true, notebookName: "X" }])
        .headline,
    ).toBe("Imported 1 file.");
  });

  test("no reason contains technical wording", () => {
    for (const r of Object.values(REASONS)) {
      expect(r).not.toMatch(/JSON|undefined|error|status|\d{3}|stack/i);
    }
  });

  test("the older signed format is recognised", () => {
    expect(isOlderSignedFormat(JSON.parse(SIGNED))).toBe(true);
    expect(isOlderSignedFormat(JSON.parse(GOOD))).toBe(false);
  });
});

describe("the summary on screen", () => {
  test("progress while it runs", () => {
    render(
      <ImportStatus
        progress={{ done: 3, total: 8 }}
        summary={null}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Importing 3 of 8…")).toBeTruthy();
  });

  test("names each file that did not import, with its reason", () => {
    render(
      <ImportStatus
        progress={null}
        summary={{
          headline: "Imported 2 of 3 files.",
          problems: [{ file: "old.pact", reason: REASONS.olderFormat }],
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Imported 2 of 3 files.")).toBeTruthy();
    expect(document.body.textContent).toContain(
      `old.pact: ${REASONS.olderFormat}`,
    );
  });

  test("nothing at all when idle", () => {
    const { container } = render(
      <ImportStatus progress={null} summary={null} onDismiss={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("the newer file chooser (part D)", () => {
  test("detected by feature: present only when showOpenFilePicker is a function", () => {
    expect(supportsOpenFilePicker({ showOpenFilePicker: () => {} })).toBe(true);
    expect(supportsOpenFilePicker({})).toBe(false); // Safari, iPad
    expect(supportsOpenFilePicker({ showOpenFilePicker: true })).toBe(false);
    expect(supportsOpenFilePicker(undefined)).toBe(false);
  });

  test("opens with a stable id, several files, .pact only", async () => {
    const picked = new File([GOOD], "a.pact");
    const showOpenFilePicker = vi.fn(async () => [
      { getFile: async () => picked },
    ]);
    const files = await pickPactFiles({ showOpenFilePicker });
    expect(files).toEqual([picked]);
    expect(showOpenFilePicker).toHaveBeenCalledWith(PICKER_OPTIONS);
    expect(PICKER_OPTIONS.id).toBe("pact-import");
    expect(PICKER_OPTIONS.multiple).toBe(true);
    expect(PICKER_OPTIONS.types[0].accept).toEqual({
      "application/octet-stream": [".pact"],
    });
  });

  test("cancelling returns nothing and shows no error", async () => {
    const showOpenFilePicker = vi.fn(async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    });
    await expect(pickPactFiles({ showOpenFilePicker })).resolves.toEqual([]);
  });

  test("any other failure is passed on, so the plain input can be used instead", async () => {
    const showOpenFilePicker = vi.fn(async () => {
      throw new DOMException("Not allowed.", "SecurityError");
    });
    await expect(pickPactFiles({ showOpenFilePicker })).rejects.toThrow();
  });
});

describe("file names (drops only)", () => {
  test("the Import button decides by content, not by name, as before", async () => {
    const out = await importPactFiles(
      [file("download-without-extension", GOOD)],
      route,
    );
    expect(out[0].ok).toBe(true);
  });

  test("a drop leaves out anything not named .pact", async () => {
    const out = await importPactFiles(
      [file("notes.txt", GOOD)],
      route,
      undefined,
      {
        requirePactName: true,
      },
    );
    expect(out[0]).toEqual({
      file: "notes.txt",
      ok: false,
      reason: REASONS.notPact,
    });
  });
});
