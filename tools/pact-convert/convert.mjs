#!/usr/bin/env node
// Task 77 -- one-time converter from older .pact files to the format
// pact-web imports today. Standalone on purpose: it shares no code with the
// app, the app's importer still accepts only the current format, and
// deleting this folder removes it completely (see README.md).
//
// The older files, measured on Nik's machine (2026-10-04, structure only):
// every one is format version 1, in one of two wrappings.
//   - Plain: the current shape, with optional fields coming and going. Some
//     carry fields pact-web has no place for -- notebook.executionMode
//     ("index" / "interactive"; pact-web is interactive-only).
//   - Signed: { version, payload, signature, signedAt, signer }, written by
//     the VSCode extension (signer "pact-local") and the legacy
//     app.pactresearch.net (signer "pactresearch.net"). payload is a plain
//     export, sometimes with xmState (the desktop app's navigation state).
//
// The converter unwraps, removes what pact-web cannot hold, and lists every
// removed field per file. A file already in the current format is copied
// byte for byte. Originals are only ever read.
//
// Usage:
//   node tools/pact-convert/convert.mjs --out <dir> [--dry-run] <file|dir>...

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_VERSION = 1;

const KNOWN_TOP = ["version", "exportedAt", "notebook", "discussions", "cells"];
const KNOWN_NOTEBOOK = ["name", "systemPrompt", "category", "totalTimeMs"];
const KNOWN_DISCUSSION = ["id", "name", "createdAt", "totalTimeMs"];
const KNOWN_CELL = [
  "id",
  "discussionId",
  "parentId",
  "promptText",
  "response",
  "model",
  "resolvedModel",
  "cellType",
  "createdAt",
];
const ENVELOPE = ["version", "payload", "signature", "signedAt", "signer"];

export class ConvertError extends Error {}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function describeRemoved(path, value) {
  if (path === "xmState") {
    return "xmState: the desktop app's navigation state (open discussion, contents list, scroll position). pact-web has no equivalent.";
  }
  if (path === "notebook.executionMode") {
    return `notebook.executionMode ("${String(value)}"): pact-web notebooks are interactive-only, so the mode is not kept.`;
  }
  return `${path}: not part of pact-web's notebook format.`;
}

// Copies only the known keys, in the input's own order, and records the rest.
function keepKnown(obj, known, path, removed) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (known.includes(key)) out[key] = value;
    else removed.push(describeRemoved(`${path}${key}`, value));
  }
  return out;
}

function keepKnownItems(items, known, label, removed) {
  const counts = new Map();
  const out = items.map((item) => {
    if (!isObj(item)) return item; // reported by validation
    const kept = {};
    for (const [key, value] of Object.entries(item)) {
      if (known.includes(key)) kept[key] = value;
      else counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return kept;
  });
  for (const [key, n] of counts) {
    removed.push(
      `${label}.${key} (in ${n} of ${items.length}): not part of pact-web's notebook format.`,
    );
  }
  return out;
}

// The same requirements pact-web's importer (lib/pactExport.ts,
// validatePactExport) enforces, plus real dates: the importer would accept
// a finite timestamp it then cannot store, and fail with a generic error.
function validate(body) {
  const fail = (msg) => {
    throw new ConvertError(msg);
  };
  const str = (v, f) =>
    typeof v === "string" ? v : fail(`${f} must be a string.`);
  const nonEmpty = (v, f) =>
    str(v, f).trim() ? v : fail(`${f} must not be empty.`);
  const optStr = (v, f) => (v === null || v === undefined ? v : str(v, f));
  const num = (v, f) =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : fail(`${f} must be a number.`);
  const date = (v, f) =>
    Number.isNaN(new Date(num(v, f)).getTime()) || Math.abs(v) > 8.64e15
      ? fail(`${f} is not a valid date.`)
      : v;

  if (!isObj(body.notebook))
    fail("Not a valid .pact file: missing notebook object.");
  nonEmpty(body.notebook.name, "notebook.name");
  optStr(body.notebook.systemPrompt, "notebook.systemPrompt");
  optStr(body.notebook.category, "notebook.category");
  if (
    body.notebook.totalTimeMs !== undefined &&
    body.notebook.totalTimeMs !== null
  ) {
    num(body.notebook.totalTimeMs, "notebook.totalTimeMs");
  }
  if (!Array.isArray(body.discussions))
    fail("Not a valid .pact file: discussions must be an array.");
  const ids = new Set();
  body.discussions.forEach((d, i) => {
    if (!isObj(d)) fail(`discussions[${i}] is not an object.`);
    ids.add(str(d.id, `discussions[${i}].id`));
    nonEmpty(d.name, `discussions[${i}].name`);
    date(d.createdAt, `discussions[${i}].createdAt`);
    num(d.totalTimeMs, `discussions[${i}].totalTimeMs`);
  });
  if (!Array.isArray(body.cells))
    fail("Not a valid .pact file: cells must be an array.");
  body.cells.forEach((c, i) => {
    if (!isObj(c)) fail(`cells[${i}] is not an object.`);
    str(c.id, `cells[${i}].id`);
    if (!ids.has(str(c.discussionId, `cells[${i}].discussionId`))) {
      fail(
        `cells[${i}].discussionId does not match any discussion in the file.`,
      );
    }
    optStr(c.parentId, `cells[${i}].parentId`);
    str(c.promptText, `cells[${i}].promptText`);
    str(c.response, `cells[${i}].response`);
    str(c.model, `cells[${i}].model`);
    optStr(c.resolvedModel, `cells[${i}].resolvedModel`);
    str(c.cellType, `cells[${i}].cellType`);
    date(c.createdAt, `cells[${i}].createdAt`);
  });
}

// Observations that change nothing in the output, for Nik's decisions.
// Legacy "referenced cell" context (approved by Nik, 2026-10-05).
//
// The legacy app built a follow-up prompt by pasting the referenced cell's
// prompt AND answer into it, nested once per level:
//
//   [Referenced Cell]\nPrompt: [Referenced Cell]\nPrompt: <Q0>\nResponse: <R1><Q1>\nResponse: <R2><own question>
//
// so every inlined piece is a copy of an earlier entry of the same notebook
// and the cell's own question is the text after the last inlined answer.
// Measured on Nik's files: 24 of 267 cells, all in Medication Interactions,
// with up to ~20,000 characters of quoted context per prompt.
//
// The prompt is replaced by its own question ONLY when the whole chain
// verifies byte for byte: Q0 is an earlier entry's (unwrapped) question,
// and each Rj is the response of an earlier entry whose question is the
// previous level's. Anything that does not verify -- a mismatch, a
// response that itself contains "\nResponse: ", an empty question -- is
// left exactly as written and reported. Duplicate prompts across entries
// of a discussion are deliberately left alone.
const REFERENCED_RUN = "[Referenced Cell]\nPrompt: ";
const REFERENCED_LEAD = /^(?:\[Referenced Cell\]\nPrompt: )+/;

function unwrapReferencedContext(body) {
  const changed = [];
  const notUnwrapped = [];
  // Earlier entries in time order, each with its own question exactly as
  // the legacy app would quote it -- untrimmed. Deeper prompts quote an
  // earlier question with its leading line break, so verification must
  // compare against that form; only the new prompt text is trimmed.
  const order = body.cells
    .map((cell, index) => ({ cell, index }))
    .sort((a, b) => a.cell.createdAt - b.cell.createdAt);
  const earlier = [];
  for (const { cell, index } of order) {
    let question = cell.promptText;
    const lead = cell.promptText.match(REFERENCED_LEAD);
    if (lead) {
      const runs = lead[0].length / REFERENCED_RUN.length;
      const pieces = cell.promptText
        .slice(lead[0].length)
        .split("\nResponse: ");
      let reason = null;
      if (pieces.length !== runs + 1) {
        reason = `expected ${runs + 1} pieces for ${runs} reference(s), found ${pieces.length}`;
      } else if (!earlier.some((e) => e.question === pieces[0])) {
        reason = "the first quoted question matches no earlier entry";
      } else {
        let previousQuestion = pieces[0];
        for (let j = 1; j < pieces.length && !reason; j++) {
          const source = earlier.find(
            (e) =>
              e.question === previousQuestion &&
              pieces[j].startsWith(e.response),
          );
          if (!source) {
            reason = `quoted answer ${j} matches no earlier entry`;
            break;
          }
          previousQuestion = pieces[j].slice(source.response.length);
          if (
            j < pieces.length - 1 &&
            !earlier.some((e) => e.question === previousQuestion)
          ) {
            reason = `quoted question ${j + 1} matches no earlier entry`;
          }
        }
        const own = previousQuestion.replace(/^\n+/, "");
        if (!reason && !own.trim())
          reason = "nothing would remain of the question";
        if (!reason) {
          changed.push({ index, removed: cell.promptText.length - own.length });
          cell.promptText = own;
          question = previousQuestion;
        }
      }
      if (reason) notUnwrapped.push({ index, reason });
    }
    earlier.push({ question, response: cell.response });
  }
  return { changed, notUnwrapped };
}

function notesFor(body) {
  const notes = [];
  const unrun = body.cells.filter((c) => !c.response.trim()).length;
  if (unrun) {
    notes.push(
      `${unrun} of ${body.cells.length} prompts were never run (empty response); kept as-is, pact-web shows them as "never run".`,
    );
  }
  const texts = [
    ["system prompt", body.notebook.systemPrompt ?? ""],
    ...body.cells.flatMap((c, i) => [
      [`cells[${i}].promptText`, c.promptText],
      [`cells[${i}].response`, c.response],
    ]),
  ];
  const escaped = texts
    .filter(([, t]) => t.includes("\\n") && !t.includes("\n"))
    .map(([where]) => where);
  if (escaped.length) {
    notes.push(
      `Literal "\\n" with no real line breaks in ${escaped.join(", ")}; kept exactly as written.`,
    );
  }
  return notes;
}

/**
 * Converts one file's text. Pure: no file system access.
 * @returns {{ status: "current" | "converted", output: string | null,
 *             notCarriedOver: string[], notes: string[] }}
 *   output is null for "current" (the caller copies the original bytes).
 */
export function convertText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConvertError(
      "Not valid JSON: the file may be truncated, or not a .pact file.",
    );
  }
  if (!isObj(data))
    throw new ConvertError("Not a .pact file: expected a JSON object.");

  const notCarriedOver = [];
  let body = data;
  let changed = false;

  if ("payload" in data && "signature" in data) {
    if (data.version !== CURRENT_VERSION) {
      throw new ConvertError(
        `Unsupported signed .pact version ${JSON.stringify(data.version)}.`,
      );
    }
    body = data.payload;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new ConvertError(
          "Not a valid .pact file: its signed payload is not readable JSON.",
        );
      }
    }
    if (!isObj(body))
      throw new ConvertError(
        "Not a valid .pact file: its signed payload is missing.",
      );
    const signer =
      typeof data.signer === "string" && /^[\w.-]{1,40}$/.test(data.signer)
        ? data.signer
        : "an unknown signer";
    notCarriedOver.push(
      `signature (signed by ${signer}): pact-web does not verify or keep .pact signatures.`,
    );
    for (const key of Object.keys(data)) {
      if (!ENVELOPE.includes(key))
        notCarriedOver.push(describeRemoved(key, data[key]));
    }
    changed = true;
  }

  if (body.version === undefined && body.notebook === undefined) {
    throw new ConvertError(
      "Not a .pact file: it has no format version and no notebook.",
    );
  }
  if (body.version !== CURRENT_VERSION) {
    throw new ConvertError(
      `Unsupported .pact version ${JSON.stringify(body.version)}.`,
    );
  }

  const removed = [];
  const out = keepKnown(body, KNOWN_TOP, "", removed);
  if (isObj(body.notebook))
    out.notebook = keepKnown(
      body.notebook,
      KNOWN_NOTEBOOK,
      "notebook.",
      removed,
    );
  if (Array.isArray(body.discussions)) {
    out.discussions = keepKnownItems(
      body.discussions,
      KNOWN_DISCUSSION,
      "discussions",
      removed,
    );
  }
  if (Array.isArray(body.cells))
    out.cells = keepKnownItems(body.cells, KNOWN_CELL, "cells", removed);
  notCarriedOver.push(...removed);
  if (removed.length) changed = true;

  validate(out);
  const notes = [];
  const unwrap = unwrapReferencedContext(out);
  if (unwrap.changed.length) {
    changed = true;
    const chars = unwrap.changed.reduce((n, c) => n + c.removed, 0);
    notes.push(
      `Unwrapped legacy referenced-cell context in ${unwrap.changed.length} of ${out.cells.length} prompts (${unwrap.changed.map((c) => `cells[${c.index}]`).join(", ")}); ${chars} characters of quoted earlier entries removed, each verified against an earlier entry.`,
    );
  }
  for (const n of unwrap.notUnwrapped) {
    notes.push(
      `Not unwrapped, left as written: cells[${n.index}] has legacy referenced-cell context, but ${n.reason}.`,
    );
  }
  notes.push(...notesFor(out));

  return changed
    ? {
        status: "converted",
        output: JSON.stringify(out, null, 2) + "\n",
        notCarriedOver,
        notes,
      }
    : { status: "current", output: null, notCarriedOver, notes };
}

function listPactFiles(input) {
  const st = statSync(input);
  if (st.isFile()) return [{ file: input, rel: basename(input) }];
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.toLowerCase().endsWith(".pact")) {
        found.push({ file: p, rel: join(basename(input), relative(input, p)) });
      }
    }
  })(input);
  return found;
}

// realpath of a path that may not exist yet: resolve its nearest existing
// ancestor, then re-append the rest. Without this a not-yet-created --out
// under a symlinked folder (macOS: /var -> /private/var) is compared in a
// different spelling from the inputs, and "inside" checks miss.
function realpathLoose(p) {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLoose(parent), basename(abs));
}

const inside = (child, parent) =>
  child === parent ||
  child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Runs the CLI. Returns the per-file results; exit code is set by main. */
export function run(argv, log = console.log) {
  const args = [...argv];
  let outDir = null;
  let dryRun = false;
  const inputs = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--out") outDir = args.shift();
    else if (a === "--dry-run") dryRun = true;
    else inputs.push(a);
  }
  if (!outDir || !inputs.length) {
    throw new ConvertError(
      "Usage: node tools/pact-convert/convert.mjs --out <dir> [--dry-run] <file|dir>...",
    );
  }
  const outAbs = resolve(outDir);
  for (const input of inputs) {
    const inAbs = realpathSync(input);
    const outReal = realpathLoose(outAbs);
    if (inside(outReal, inAbs) || inside(inAbs, outReal)) {
      throw new ConvertError(
        `--out must be outside the inputs, and the inputs outside --out (${input}).`,
      );
    }
  }

  const results = [];
  for (const input of inputs) {
    for (const { file, rel } of listPactFiles(input)) {
      const target = join(outAbs, rel);
      let result;
      try {
        result = convertText(readFileSync(file, "utf8"));
        if (!dryRun) {
          mkdirSync(dirname(target), { recursive: true });
          if (existsSync(target))
            throw new ConvertError(`Output already exists: ${target}`);
          if (result.status === "current") copyFileSync(file, target);
          else writeFileSync(target, result.output, { flag: "wx" });
        }
        results.push({
          file,
          target: dryRun ? null : target,
          ...result,
          output: undefined,
        });
      } catch (error) {
        if (!(error instanceof ConvertError)) throw error;
        results.push({
          file,
          status: "error",
          error: error.message,
          notCarriedOver: [],
          notes: [],
        });
      }
    }
  }

  const lines = [];
  for (const r of results) {
    lines.push(`${r.status.toUpperCase().padEnd(9)} ${r.file}`);
    if (r.error) lines.push(`    error: ${r.error}`);
    for (const n of r.notCarriedOver) lines.push(`    not carried over: ${n}`);
    for (const n of r.notes) lines.push(`    note: ${n}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push(
    "",
    `${results.length} files: ${count("converted")} converted, ${count("current")} already current (copied unchanged), ${count("error")} errors.${dryRun ? " Dry run: nothing written." : ""}`,
  );
  const report = lines.join("\n") + "\n";
  log(report);
  if (!dryRun) {
    mkdirSync(outAbs, { recursive: true });
    writeFileSync(join(outAbs, "conversion-report.txt"), report);
  }
  return results;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const results = run(process.argv.slice(2));
    process.exitCode = results.some((r) => r.status === "error") ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
