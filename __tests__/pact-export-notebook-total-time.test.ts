import { describe, expect, test } from "vitest";
import { PACT_EXPORT_VERSION, validatePactExport } from "@/lib/pactExport";
import { sumDiscussionTotalTimeMs } from "@/lib/activityRollup";

// Task 55d. The notebook-level totalTimeMs carried in a .pact file.
//
// The validator rebuilds the notebook object field by field, so a field
// that is not explicitly allow-listed is silently dropped on import.
// That makes "does it survive a round trip" a real question about this
// function, not a formality.

function fileWithNotebook(notebook: Record<string, unknown>) {
  return {
    version: PACT_EXPORT_VERSION,
    exportedAt: 1_700_000_000_000,
    notebook: { name: "Notebook1", systemPrompt: null, ...notebook },
    discussions: [
      { id: "d1", name: "Notebook1-d-1", createdAt: 1, totalTimeMs: 1200 },
      { id: "d2", name: "Notebook1-d-2", createdAt: 2, totalTimeMs: 800 },
    ],
    cells: [],
  };
}

describe("notebook.totalTimeMs in .pact", () => {
  test("survives validation instead of being dropped", () => {
    const parsed = validatePactExport(fileWithNotebook({ totalTimeMs: 2000 }));
    expect(parsed.notebook.totalTimeMs).toBe(2000);
  });

  // The backward-compatibility requirement: every .pact file written
  // before task 55d lacks this field entirely, and must still import.
  test("a file without the field still imports, and does not invent a zero", () => {
    const parsed = validatePactExport(fileWithNotebook({}));
    expect(parsed.notebook.totalTimeMs).toBeUndefined();
    // A measured zero and no measurement are different claims. Writing
    // 0 here would assert the first while meaning the second.
    expect(parsed.notebook.totalTimeMs).not.toBe(0);
    // The rest of the file is untouched by the new field.
    expect(parsed.notebook.name).toBe("Notebook1");
    expect(parsed.discussions).toHaveLength(2);
  });

  test("an explicit zero is preserved as a real measurement", () => {
    const parsed = validatePactExport(fileWithNotebook({ totalTimeMs: 0 }));
    expect(parsed.notebook.totalTimeMs).toBe(0);
  });

  test("a non-numeric value is rejected with a field-specific message", () => {
    expect(() =>
      validatePactExport(fileWithNotebook({ totalTimeMs: "2000" })),
    ).toThrow(/notebook\.totalTimeMs must be a number/);
  });

  // PACT_EXPORT_VERSION must NOT have moved: an optional additive field
  // is interoperable, and bumping it would reject every existing file
  // and every file pact-mac writes.
  test("the format version is unchanged", () => {
    expect(PACT_EXPORT_VERSION).toBe(1);
  });
});

describe("sumDiscussionTotalTimeMs", () => {
  // The same helper the live notebook rollup uses. One definition, so
  // the exported number and the displayed number cannot disagree.
  test("sums stored totals and treats null as zero", () => {
    expect(
      sumDiscussionTotalTimeMs([
        { total_time_ms: 1200 },
        { total_time_ms: null },
        { total_time_ms: 800 },
      ]),
    ).toBe(2000);
  });

  test("an empty notebook sums to zero rather than throwing", () => {
    expect(sumDiscussionTotalTimeMs([])).toBe(0);
  });
});
