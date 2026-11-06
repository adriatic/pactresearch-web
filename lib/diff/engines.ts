// Task D12. The diff engines, as plain library code. Copied from the
// diff-tests lab (adriatic/diff-tests, lib/engines.ts at 46ce062) and
// reformatted; the results, counts and spacing are the lab's.
//
// Nothing in the app uses this yet (D13 adds the Diff view). It imports
// only the "diff" package: no app code, no environment, no network. The
// lab's Meaning engine, which asks a language model, comes in D15; the
// DiffEngine type keeps the slots it will need (runsOnCompareOnly,
// sendsTextToProvider, price, an asynchronous compare).

import { diffChars, diffLines, diffWordsWithSpace, type Change } from "diff";

/** A run of text in a marked-text result: unchanged, added in B, or removed from A. */
export type Segment = { text: string; kind: "same" | "added" | "removed" };

/** One item in a findings result (JSON paths, matched statements). */
export type Finding = {
  topic: string;
  type: "agreement" | "conflict" | "unique" | "uncertain";
  a: string;
  b: string;
  explanation: string;
};

/** What every engine returns. */
export type Result = {
  segments: Segment[];
  findings: Finding[];
  summary: string;
  added: number;
  removed: number;
  unchanged: number;
  changed?: number;
  error?: string;
  /** Which input could not be read (JSON engine: not valid JSON). */
  invalid?: ("A" | "B")[];
  /** Tokens used, for an engine that asks a language model (none yet). */
  usage?: { inputTokens: number; outputTokens: number };
};

/** How a result can be shown: marked text inline or side by side, or a list of findings. */
export type View = "inline" | "side" | "findings";

/** One number in the results header, with its unit. */
export type Count = { text: string; tone?: "green" | "red" | "amber" };

/** Every engine is described the same way; a view builds its selector, tabs, counts and export from this. */
export type DiffEngine = {
  id: string;
  label: string;
  /** inline and side show the marked text; findings means the result is a list of findings. */
  views: View[];
  /** Put a space between a removed part and the added part right after it (see needsReplacementGap). */
  separateReplacements?: boolean;
  /** The sample to load for this engine, if not the default text. */
  sample?: { a: string; b: string };
  /** May be asynchronous, for an engine added later that calls a service. */
  compare: (a: string, b: string) => Result | Promise<Result>;
  /** The numbers in the results header, with their unit. */
  counts: (r: Result) => Count[];
  /** Run only on an explicit Compare (e.g. a paid engine), never on typing or switching. */
  runsOnCompareOnly?: boolean;
  /** The service the two texts are sent to, if any. */
  sendsTextToProvider?: string;
  /** US dollars per million tokens, for an estimated cost. */
  price?: { inputPerMTok: number; outputPerMTok: number };
};

const kind = (x: Change): Segment["kind"] =>
  x.added ? "added" : x.removed ? "removed" : "same";

/** The unit each text engine counts in. */
export const measure = {
  line: (t: string) =>
    t ? (t.match(/\n/g)?.length ?? 0) + (t.endsWith("\n") ? 0 : 1) : 0,
  word: (t: string) => t.match(/\S+/g)?.length ?? 0,
  character: (t: string) => t.length,
};

function fromChanges(
  changes: Change[],
  unit: string,
  size: (t: string) => number,
): Result {
  const segments = changes.map((x) => ({ text: x.value, kind: kind(x) }));
  const count = (k: Segment["kind"]) =>
    segments.filter((x) => x.kind === k).reduce((n, x) => n + size(x.text), 0);
  return {
    segments,
    findings: [],
    summary: `${unit} comparison · changes highlighted below`,
    added: count("added"),
    removed: count("removed"),
    unchanged: count("same"),
  };
}

// JSON: every leaf becomes a path ($.config.timeout, $.items[0]) with its
// value written as JSON; empty objects and arrays count as leaves.
function flatten(
  value: unknown,
  path = "$",
  out: Record<string, string> = {},
): Record<string, string> {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) out[path] = Array.isArray(value) ? "[]" : "{}";
    for (const [k, v] of entries) {
      flatten(v, Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`, out);
    }
  } else {
    out[path] = JSON.stringify(value);
  }
  return out;
}

const parse = (s: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

function jsonDiff(a: string, b: string): Result {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa.ok || !pb.ok) {
    const invalid: ("A" | "B")[] = [
      ...(pa.ok ? [] : ["A" as const]),
      ...(pb.ok ? [] : ["B" as const]),
    ];
    return {
      segments: [],
      findings: [],
      summary: "Invalid JSON",
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
      error: invalid.map((x) => `Input ${x} is not valid JSON`).join("\n"),
      invalid,
    };
  }
  const x = flatten(pa.value);
  const y = flatten(pb.value);
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  const findings: Finding[] = keys
    .filter((k) => x[k] !== y[k])
    .map((k) => ({
      topic: k,
      type: x[k] === undefined || y[k] === undefined ? "unique" : "conflict",
      a: x[k] ?? "(missing)",
      b: y[k] ?? "(missing)",
      explanation:
        x[k] === undefined
          ? "Added in B"
          : y[k] === undefined
            ? "Removed from B"
            : "Value changed",
    }));
  return {
    segments: [],
    findings,
    summary: `${findings.length} changed JSON paths · ${keys.length - findings.length} unchanged`,
    added: findings.filter((f) => f.a === "(missing)").length,
    removed: findings.filter((f) => f.b === "(missing)").length,
    changed: findings.filter((f) => f.type === "conflict").length,
    unchanged: keys.length - findings.length,
  };
}

// Semantic (heuristic): sentences matched by shared words. Lexical only,
// not a language model and not a contradiction detector.
const stop = new Set(
  "the a an and or but in on at to for from of is are was were be been being it this that these those with by as about into can should would could will use using we you they i he she do does did not only both same also".split(
    " ",
  ),
);

const tokens = (s: string) =>
  new Set(
    (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
      (w) => w.length > 2 && !stop.has(w),
    ),
  );

const similarity = (a: string, b: string) => {
  const x = tokens(a);
  const y = tokens(b);
  const intersection = [...x].filter((w) => y.has(w)).length;
  return x.size + y.size ? (2 * intersection) / (x.size + y.size) : 1;
};

const sentences = (s: string) =>
  s
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 80);

const negation =
  /\b(no|not|never|without|avoid|disable|cannot|don't|doesn't|won't)\b/i;

function semantic(a: string, b: string): Result {
  const aa = sentences(a);
  const bb = sentences(b);
  const used = new Set<number>();
  const findings: Finding[] = [];
  for (const s of aa) {
    let index = -1;
    let best = 0;
    bb.forEach((t, i) => {
      if (!used.has(i)) {
        const score = similarity(s, t);
        if (score > best) {
          best = score;
          index = i;
        }
      }
    });
    if (index >= 0 && best >= 0.34) {
      used.add(index);
      const t = bb[index];
      const mismatch = negation.test(s) !== negation.test(t);
      findings.push({
        topic: `Statement ${findings.length + 1}`,
        type: mismatch ? "uncertain" : best >= 0.78 ? "agreement" : "uncertain",
        a: s,
        b: t,
        explanation: mismatch
          ? "Possible polarity difference; verify manually"
          : best >= 0.78
            ? "Strong lexical overlap; not proof of semantic agreement"
            : "Related wording; review the meaning manually",
      });
    } else {
      findings.push({
        topic: `Statement ${findings.length + 1}`,
        type: "unique",
        a: s,
        b: "(no close match)",
        explanation: "Only found in A under the lexical matching threshold",
      });
    }
  }
  bb.forEach((s, i) => {
    if (!used.has(i)) {
      findings.push({
        topic: `Statement ${findings.length + 1}`,
        type: "unique",
        a: "(no close match)",
        b: s,
        explanation: "Only found in B under the lexical matching threshold",
      });
    }
  });
  return {
    segments: [],
    findings,
    summary:
      "Experimental lexical-semantic matching · NOT an LLM or contradiction detector",
    added: findings.filter((x) => x.type === "unique").length,
    removed: 0,
    unchanged: findings.filter((x) => x.type === "agreement").length,
  };
}

const unitCounts =
  (one: string, many: string) =>
  (r: Result): Count[] => {
    const u = (n: number) => (n === 1 ? one : many);
    return [
      { text: `+${r.added} ${u(r.added)}`, tone: "green" },
      { text: `−${r.removed} ${u(r.removed)}`, tone: "red" },
      { text: `${r.unchanged} ${u(r.unchanged)} matched` },
    ];
  };

const jsonCounts = (r: Result): Count[] => [
  { text: `+${r.added} added`, tone: "green" },
  { text: `−${r.removed} removed`, tone: "red" },
  { text: `~${r.changed ?? 0} changed`, tone: "amber" },
  { text: `${r.unchanged} unchanged` },
];

const jsonSample = {
  a: '{"model":"gpt-4.1","stream":false,"retry":1,"config":{"timeout":30}}',
  b: '{"model":"gpt-6","stream":true,"retry":3,"config":{"timeout":30}}',
};

/** The registry: the first entry is the default. A new engine needs only a new entry here. */
export const engines: DiffEngine[] = [
  {
    id: "word",
    label: "Word diff",
    views: ["inline", "side"],
    separateReplacements: true,
    compare: (a, b) =>
      fromChanges(diffWordsWithSpace(a, b), "Word", measure.word),
    counts: unitCounts("word", "words"),
  },
  {
    id: "line",
    label: "Line diff",
    views: ["inline", "side"],
    compare: (a, b) => fromChanges(diffLines(a, b), "Line", measure.line),
    counts: unitCounts("line", "lines"),
  },
  {
    id: "character",
    label: "Character diff",
    views: ["inline", "side"],
    compare: (a, b) =>
      fromChanges(diffChars(a, b), "Character", measure.character),
    counts: unitCounts("character", "characters"),
  },
  {
    id: "json",
    label: "JSON structural diff",
    views: ["findings"],
    sample: jsonSample,
    compare: jsonDiff,
    counts: jsonCounts,
  },
  {
    id: "semantic",
    label: "Semantic (heuristic)",
    views: ["findings"],
    compare: semantic,
    counts: unitCounts("statement", "statements"),
  },
];

/** The engine with this id, or the first (Word diff) if there is none. */
export const findEngine = (id: string): DiffEngine =>
  engines.find((e) => e.id === id) ?? engines[0];

/** A result that carries an error and nothing else. */
export const failed = (e: unknown): Result => ({
  segments: [],
  findings: [],
  summary: "Comparison failed",
  added: 0,
  removed: 0,
  unchanged: 0,
  error: e instanceof Error ? e.message : String(e),
});

/**
 * The lab's replacement spacing, moved here from its page: true when a
 * view should show a space between this removed segment and the added
 * segment right after it, so "oldnew" reads "old new". Only for engines
 * with separateReplacements (Word diff), and only when neither side
 * already has the space.
 */
export const needsReplacementGap = (
  engine: Pick<DiffEngine, "separateReplacements">,
  segment: Segment,
  next?: Segment,
): boolean =>
  !!engine.separateReplacements &&
  segment.kind === "removed" &&
  next?.kind === "added" &&
  !/\s$/.test(segment.text) &&
  !/^\s/.test(next.text);
