import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PACT_EXPORT_VERSION,
  readPactFile,
  validatePactExport,
} from "@/lib/pactExport";

// Task 77. Fixtures in __tests__/fixtures/pact-older keep the structure of
// real older .pact files (envelope fields, signer labels, xmState layout,
// executionMode, model names, cellType "user", parentId chains) with all
// content synthetic -- some of the real files are customer research.

const dir = join(__dirname, "fixtures", "pact-older");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("signed files from older PACT apps", () => {
  test("the extension's signed export unwraps, naming what it leaves behind", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("signed-pact-local-with-xmstate.pact"),
    );
    expect(pactExport.notebook.name).toBe("Fixture signed extension notebook");
    expect(pactExport.notebook.category).toBe("dev-tests");
    expect(pactExport.discussions).toHaveLength(2);
    expect(pactExport.cells).toHaveLength(4);
    expect(pactExport.cells.every((c) => c.cellType === "user")).toBe(true);

    expect(notCarriedOver).toHaveLength(3);
    expect(notCarriedOver[0]).toMatch(/signature \(signed by pact-local\)/);
    expect(notCarriedOver.join("\n")).toMatch(/^xmState: /m);
    expect(notCarriedOver.join("\n")).toMatch(
      /notebook\.executionMode \("index"\)/,
    );
  });

  test("the legacy app's signed export unwraps with its resolved models", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("signed-pactresearch-net.pact"),
    );
    expect(pactExport.cells).toHaveLength(3);
    expect(pactExport.cells[0].resolvedModel).toBe("claude-sonnet-4-6");
    expect(notCarriedOver).toEqual([
      "The file's signature (signed by pactresearch.net): pact-web does not verify or keep .pact signatures.",
    ]);
  });

  test("a payload stored as a JSON string is read too", () => {
    const signed = load("signed-pactresearch-net.pact") as Record<
      string,
      unknown
    >;
    const { pactExport } = readPactFile({
      ...signed,
      payload: JSON.stringify(signed.payload),
    });
    expect(pactExport.cells).toHaveLength(3);
  });

  test("a signer that is not a short label is not echoed back", () => {
    const signed = load("signed-pactresearch-net.pact") as Record<
      string,
      unknown
    >;
    const { notCarriedOver } = readPactFile({
      ...signed,
      signer: "<script>alert(1)</script>",
    });
    expect(notCarriedOver[0]).toMatch(/signed by an unknown signer/);
  });

  test("an unreadable signed payload fails clearly", () => {
    const signed = load("signed-pactresearch-net.pact") as Record<
      string,
      unknown
    >;
    expect(() => readPactFile({ ...signed, payload: "{not json" })).toThrow(
      /signed payload is not readable JSON/,
    );
  });
});

describe("plain files from older PACT apps", () => {
  test("pact-mac: category kept as written, execution mode named as dropped", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("plain-pact-mac-category-mode.pact"),
    );
    expect(pactExport.notebook.category).toBe("user-requests");
    expect(notCarriedOver).toEqual([
      'notebook.executionMode ("interactive"): pact-web notebooks are interactive-only, so the mode is not kept.',
    ]);
  });

  test("oldest notebooks: generic model name and parent chain carry over intact", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("plain-old-gpt-parent-chain.pact"),
    );
    expect(notCarriedOver).toEqual([]);
    expect(pactExport.cells.map((c) => c.model)).toEqual(["gpt", "gpt", "gpt"]);
    expect(pactExport.cells[0].parentId).toBeNull();
    expect(pactExport.cells[1].parentId).toBe(pactExport.cells[0].id);
    expect(pactExport.cells[2].parentId).toBe(pactExport.cells[1].id);
    // No resolved model in these files; absent, not invented.
    expect(pactExport.cells[0].resolvedModel).toBeNull();
  });

  test("minimal oldest shape loses nothing", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("plain-old-minimal.pact"),
    );
    expect(notCarriedOver).toEqual([]);
    expect(pactExport.notebook.category).toBeNull();
    expect(pactExport.notebook.totalTimeMs).toBeUndefined();
    expect(pactExport.discussions).toHaveLength(2);
  });

  test("a notebook whose discussions have no cells imports as such", () => {
    const { pactExport, notCarriedOver } = readPactFile(
      load("plain-early-pact-web-no-cells.pact"),
    );
    expect(notCarriedOver).toEqual([]);
    expect(pactExport.discussions).toHaveLength(1);
    expect(pactExport.cells).toEqual([]);
  });

  test("an unknown cell field is reported once, with how many cells had it", () => {
    const file = load("plain-old-minimal.pact") as {
      cells: Record<string, unknown>[];
    };
    file.cells[0].rating = 5;
    const { notCarriedOver } = readPactFile(file);
    expect(notCarriedOver).toEqual([
      "cells.rating (in 1 of 2): not part of pact-web's notebook format.",
    ]);
  });
});

describe("current pact-web files are unchanged", () => {
  const current = {
    version: PACT_EXPORT_VERSION,
    exportedAt: 1790000000000,
    notebook: {
      name: "Current",
      systemPrompt: null,
      category: "Personal Research",
      totalTimeMs: 3000,
    },
    discussions: [
      { id: "d1", name: "One", createdAt: 1790000000000, totalTimeMs: 3000 },
    ],
    cells: [
      {
        id: "c1",
        discussionId: "d1",
        parentId: null,
        promptText: "p",
        response: "r",
        model: "claude-haiku-4-5",
        resolvedModel: "claude-haiku-4-5-20251001",
        cellType: "assistant",
        createdAt: 1790000001000,
      },
    ],
  };

  test("read exactly as validatePactExport reads it, with nothing dropped", () => {
    const { pactExport, notCarriedOver } = readPactFile(current);
    expect(notCarriedOver).toEqual([]);
    expect(pactExport).toEqual(validatePactExport(current));
  });
});

describe("files that are not usable", () => {
  test("a truncated file is not valid JSON", () => {
    const text = readFileSync(join(dir, "truncated.pact"), "utf8");
    expect(() => JSON.parse(text)).toThrow();
  });

  test("JSON that is not a .pact file says so", () => {
    expect(() => readPactFile({ hello: "world" })).toThrow(
      "Not a .pact file: it has no format version and no notebook.",
    );
  });

  test("a signed envelope of an unknown version is refused", () => {
    const signed = load("signed-pactresearch-net.pact") as Record<
      string,
      unknown
    >;
    expect(() => readPactFile({ ...signed, version: 2 })).toThrow(
      /Unsupported signed .pact file version/,
    );
  });
});
