import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  engines,
  failed,
  findEngine,
  measure,
  needsReplacementGap,
  type Result,
  type Segment,
} from "@/lib/diff/engines";

// Task D12. The diff engines from the diff-tests lab, as a library that
// nothing in the app uses yet. The samples are the lab's own (its page's
// default A and B texts, and the JSON engine's sample); the expected
// numbers are what the lab's engines give for them.

const SAMPLE_A = `Use a central execution engine with provider adapters.
Stream tokens through a shared event bus.
A retry creates a new execution cell.
Abort the provider request when Stop is pressed.`;
const SAMPLE_B = `Use a central orchestrator with model adapters.
Stream provider deltas through a normalized event interface.
A retry creates a new attempt within the same cell.
Mark a run as cancelling and wait for confirmation.`;

// Every text engine's segments put back together give A (without the
// added parts) and B (without the removed parts).
function rebuild(segments: Segment[]) {
  const a = segments
    .filter((s) => s.kind !== "added")
    .map((s) => s.text)
    .join("");
  const b = segments
    .filter((s) => s.kind !== "removed")
    .map((s) => s.text)
    .join("");
  return { a, b };
}

const run = (id: string, a: string, b: string) =>
  findEngine(id).compare(a, b) as Result;
const countTexts = (id: string, r: Result) =>
  findEngine(id)
    .counts(r)
    .map((c) => c.text);

describe("the registry", () => {
  it("holds word, line, character, JSON and semantic, in that order, and no Meaning engine", () => {
    expect(engines.map((e) => e.id)).toEqual([
      "word",
      "line",
      "character",
      "json",
      "semantic",
    ]);
    expect(engines.map((e) => e.label)).toEqual([
      "Word diff",
      "Line diff",
      "Character diff",
      "JSON structural diff",
      "Semantic (heuristic)",
    ]);
    for (const e of engines) {
      expect(e.runsOnCompareOnly).toBeUndefined();
      expect(e.sendsTextToProvider).toBeUndefined();
      expect(e.price).toBeUndefined();
    }
  });

  it("text engines show marked text; JSON and semantic show findings", () => {
    expect(findEngine("word").views).toEqual(["inline", "side"]);
    expect(findEngine("line").views).toEqual(["inline", "side"]);
    expect(findEngine("character").views).toEqual(["inline", "side"]);
    expect(findEngine("json").views).toEqual(["findings"]);
    expect(findEngine("semantic").views).toEqual(["findings"]);
  });

  it("findEngine falls back to the first engine, Word diff", () => {
    expect(findEngine("meaning").id).toBe("word");
    expect(findEngine("").id).toBe("word");
  });

  it("failed() carries only the error", () => {
    expect(failed(new Error("boom"))).toEqual({
      segments: [],
      findings: [],
      summary: "Comparison failed",
      added: 0,
      removed: 0,
      unchanged: 0,
      error: "boom",
    });
    expect(failed("plain").error).toBe("plain");
  });
});

describe("word diff", () => {
  it("marks the changed word and counts in words", () => {
    const r = run("word", "The cat sat.", "The dog sat.");
    expect(r.segments).toEqual([
      { text: "The ", kind: "same" },
      { text: "cat", kind: "removed" },
      { text: "dog", kind: "added" },
      { text: " sat.", kind: "same" },
    ]);
    expect(countTexts("word", r)).toEqual([
      "+1 word",
      "−1 word",
      "2 words matched",
    ]);
  });

  it("the lab sample: +19, −15, 17 matched words", () => {
    const r = run("word", SAMPLE_A, SAMPLE_B);
    expect([r.added, r.removed, r.unchanged]).toEqual([19, 15, 17]);
    expect(r.summary).toBe("Word comparison · changes highlighted below");
    expect(rebuild(r.segments)).toEqual({ a: SAMPLE_A, b: SAMPLE_B });
  });
});

describe("line diff", () => {
  it("marks changed and added lines and counts in lines", () => {
    const r = run("line", "a\nb\nc\n", "a\nB\nc\nd\n");
    expect(r.segments).toEqual([
      { text: "a\n", kind: "same" },
      { text: "b\n", kind: "removed" },
      { text: "B\n", kind: "added" },
      { text: "c\n", kind: "same" },
      { text: "d\n", kind: "added" },
    ]);
    expect(countTexts("line", r)).toEqual([
      "+2 lines",
      "−1 line",
      "2 lines matched",
    ]);
  });

  it("the lab sample: every one of the four lines changed", () => {
    const r = run("line", SAMPLE_A, SAMPLE_B);
    expect([r.added, r.removed, r.unchanged]).toEqual([4, 4, 0]);
    expect(rebuild(r.segments)).toEqual({ a: SAMPLE_A, b: SAMPLE_B });
  });

  it("counts a last line without a newline as a line", () => {
    expect(measure.line("")).toBe(0);
    expect(measure.line("one")).toBe(1);
    expect(measure.line("one\n")).toBe(1);
    expect(measure.line("one\ntwo")).toBe(2);
  });
});

describe("character diff", () => {
  it("kitten to sitting: +3, −2, 4 matched characters", () => {
    const r = run("character", "kitten", "sitting");
    expect(r.segments).toEqual([
      { text: "k", kind: "removed" },
      { text: "s", kind: "added" },
      { text: "itt", kind: "same" },
      { text: "e", kind: "removed" },
      { text: "i", kind: "added" },
      { text: "n", kind: "same" },
      { text: "g", kind: "added" },
    ]);
    expect(countTexts("character", r)).toEqual([
      "+3 characters",
      "−2 characters",
      "4 characters matched",
    ]);
  });

  it("the lab sample: +93, −64, 119 matched characters", () => {
    const r = run("character", SAMPLE_A, SAMPLE_B);
    expect([r.added, r.removed, r.unchanged]).toEqual([93, 64, 119]);
    expect(rebuild(r.segments)).toEqual({ a: SAMPLE_A, b: SAMPLE_B });
  });
});

describe("JSON structural diff", () => {
  it("the lab's JSON sample: three changed paths, one unchanged", () => {
    const json = findEngine("json");
    const r = json.compare(json.sample!.a, json.sample!.b) as Result;
    expect(r.findings.map((f) => [f.topic, f.type, f.a, f.b])).toEqual([
      ["$.model", "conflict", '"gpt-4.1"', '"gpt-6"'],
      ["$.retry", "conflict", "1", "3"],
      ["$.stream", "conflict", "false", "true"],
    ]);
    expect(r.summary).toBe("3 changed JSON paths · 1 unchanged");
    expect(json.counts(r).map((c) => [c.text, c.tone])).toEqual([
      ["+0 added", "green"],
      ["−0 removed", "red"],
      ["~3 changed", "amber"],
      ["1 unchanged", undefined],
    ]);
  });

  it("names added, removed and changed paths, arrays and empty containers included", () => {
    const r = run(
      "json",
      '{"a":1,"b":{"c":[1,2]},"d":{}}',
      '{"a":2,"b":{"c":[1]},"e":null,"d":[]}',
    );
    expect(
      r.findings.map((f) => [f.topic, f.type, f.a, f.b, f.explanation]),
    ).toEqual([
      ["$.a", "conflict", "1", "2", "Value changed"],
      ["$.b.c[1]", "unique", "2", "(missing)", "Removed from B"],
      ["$.d", "conflict", "{}", "[]", "Value changed"],
      ["$.e", "unique", "(missing)", "null", "Added in B"],
    ]);
    expect([r.added, r.removed, r.changed, r.unchanged]).toEqual([1, 1, 2, 1]);
  });

  it("says which input is not valid JSON", () => {
    const both = run("json", "{bad", "[1");
    expect(both.summary).toBe("Invalid JSON");
    expect(both.invalid).toEqual(["A", "B"]);
    expect(both.error).toBe(
      "Input A is not valid JSON\nInput B is not valid JSON",
    );
    expect(run("json", "{}", "{bad").invalid).toEqual(["B"]);
  });
});

describe("semantic (heuristic)", () => {
  it("finds a polarity difference, an agreement and a statement only in B", () => {
    const r = run(
      "semantic",
      "Enable the cache for every request.\nLogs are kept for seven days.",
      "Do not enable the cache for every request.\nLogs are kept for seven days.\nMetrics go to the dashboard.",
    );
    expect(r.findings.map((f) => [f.topic, f.type, f.explanation])).toEqual([
      [
        "Statement 1",
        "uncertain",
        "Possible polarity difference; verify manually",
      ],
      [
        "Statement 2",
        "agreement",
        "Strong lexical overlap; not proof of semantic agreement",
      ],
      [
        "Statement 3",
        "unique",
        "Only found in B under the lexical matching threshold",
      ],
    ]);
    expect(countTexts("semantic", r)).toEqual([
      "+1 statement",
      "−0 statements",
      "1 statement matched",
    ]);
    expect(r.summary).toContain("NOT an LLM");
  });

  it("the lab sample: two statements only in one text, none matched", () => {
    const r = run("semantic", SAMPLE_A, SAMPLE_B);
    expect([r.added, r.removed, r.unchanged]).toEqual([2, 0, 0]);
  });
});

describe("spaced replacements", () => {
  const word = findEngine("word");
  const removed: Segment = { text: "cat", kind: "removed" };
  const added: Segment = { text: "dog", kind: "added" };

  it("Word diff separates a removed word from the added word after it", () => {
    expect(word.separateReplacements).toBe(true);
    expect(needsReplacementGap(word, removed, added)).toBe(true);
  });

  it("no gap when a side already has the space, or the pair is not removed then added", () => {
    expect(
      needsReplacementGap(word, { text: "cat ", kind: "removed" }, added),
    ).toBe(false);
    expect(
      needsReplacementGap(word, removed, { text: " dog", kind: "added" }),
    ).toBe(false);
    expect(needsReplacementGap(word, added, removed)).toBe(false);
    expect(needsReplacementGap(word, removed)).toBe(false);
    expect(
      needsReplacementGap(word, removed, { text: "x", kind: "same" }),
    ).toBe(false);
  });

  it("other engines never add the gap", () => {
    for (const id of ["line", "character", "json", "semantic"]) {
      expect(needsReplacementGap(findEngine(id), removed, added), id).toBe(
        false,
      );
    }
  });
});

describe("edge cases", () => {
  it("empty input on both sides: nothing found, nothing counted", () => {
    for (const id of ["word", "line", "character", "semantic"]) {
      const r = run(id, "", "");
      expect([r.added, r.removed, r.unchanged], id).toEqual([0, 0, 0]);
      expect(r.findings, id).toEqual([]);
      expect(r.error, id).toBeUndefined();
    }
    // Empty is not valid JSON, and the JSON engine says so.
    expect(run("json", "", "").invalid).toEqual(["A", "B"]);
  });

  it("one side empty: all added, or all removed", () => {
    expect(run("word", "", "two words")).toMatchObject({
      added: 2,
      removed: 0,
      unchanged: 0,
    });
    expect(run("line", "a\nb", "")).toMatchObject({
      added: 0,
      removed: 2,
      unchanged: 0,
    });
  });

  it("identical input: everything matched, nothing added or removed", () => {
    for (const id of ["word", "line", "character"]) {
      const r = run(id, SAMPLE_A, SAMPLE_A);
      expect([r.added, r.removed], id).toEqual([0, 0]);
      expect(
        r.segments.every((s) => s.kind === "same"),
        id,
      ).toBe(true);
    }
    expect(run("word", SAMPLE_A, SAMPLE_A).unchanged).toBe(30);
    expect(run("line", SAMPLE_A, SAMPLE_A).unchanged).toBe(4);
    expect(run("character", SAMPLE_A, SAMPLE_A).unchanged).toBe(
      SAMPLE_A.length,
    );
    const json = findEngine("json").sample!.a;
    expect(run("json", json, json)).toMatchObject({
      findings: [],
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 4,
    });
    const sem = run("semantic", SAMPLE_A, SAMPLE_A);
    expect(sem.findings.every((f) => f.type === "agreement")).toBe(true);
    expect(sem.unchanged).toBe(4);
  });

  it("very long input still finishes, in every engine", () => {
    // About 200,000 characters on each side, one word changed in the
    // middle (the usual case: a long answer, slightly edited).
    const long = (SAMPLE_A + "\n").repeat(1000);
    const edited =
      long.slice(0, long.length / 2) + "changed " + long.slice(long.length / 2);
    // About 20,000 characters on each side, every line different.
    const manyA = (SAMPLE_A + "\n").repeat(50);
    const manyB = (SAMPLE_B + "\n").repeat(50);
    const jsonA = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({ i, v: `value ${i}` })),
    );
    const jsonB = jsonA.replace('"value 2500"', '"value two"');
    for (const e of engines) {
      const [a1, b1] = e.id === "json" ? [jsonA, jsonB] : [long, edited];
      const r = e.compare(a1, b1) as Result;
      expect(r.error, e.id).toBeUndefined();
      const r2 = e.compare(manyA, manyB) as Result;
      expect(r2.summary, e.id).toBeTruthy();
    }
    expect(run("word", long, edited).added).toBe(1);
    expect(run("json", jsonA, jsonB).changed).toBe(1);
    // The semantic engine looks at the first 80 sentences of each text.
    expect(run("semantic", long, edited).findings.length).toBeLessThanOrEqual(
      160,
    );
  }, 60_000);
});

describe("a library, apart from the app", () => {
  const source = readFileSync(
    join(__dirname, "..", "lib", "diff", "engines.ts"),
    "utf8",
  );

  it("imports nothing but the diff package: no app code, nothing else", () => {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(["diff"]);
    expect(source).not.toMatch(/require\(|import\(/);
  });

  it("does not read process.env, call the network or mention a language model engine", () => {
    expect(source).not.toMatch(/process\.env|process\[/);
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    expect(source).not.toMatch(/compareMeaning|\.env\.local|\/api\//);
  });

  // Task D13: the Compare page is the first, and so far only, user.
  it("only the Compare page (app/compare/) imports the library", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const appFiles = files(join(__dirname, "..", "app"));
    expect(appFiles.length).toBeGreaterThan(20);
    const users = appFiles
      .filter((f) => /lib\/diff\/|diff\/engines/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(join(__dirname, "..").length + 1));
    expect(users.every((f) => f.startsWith("app/compare/"))).toBe(true);
  });
});
