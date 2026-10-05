// .pact export/import format, ported from pact-mac's PactExport
// (src/storage/notebookStore.ts) for one specific purpose: repeatable
// test fixtures for the timing/instrumentation work. A .pact file is
// meant to be fully equivalent to a notebook instance -- importing the
// same file twice produces two independent, content-identical notebooks,
// every time.
//
// Deliberately NOT ported from pact-mac:
//   - xmState: desktop-only UI navigation state, not applicable to web.
//   - signing: pact-mac signs exports with a per-machine Ed25519 key --
//     doesn't translate to a multi-user web app (no single "local
//     machine" identity), and isn't needed for test fixtures. Export and
//     import here are plain, unsigned JSON.
//   - notebook.executionMode: this app's own schema has never had a
//     column for it -- the very first migration's own header says the
//     scope is "single-user Interactive mode only... Index mode dropped
//     entirely." There's no dual-mode concept here to preserve.
//
// Known lossy/excluded fields (see the export function's own comments
// for the full field-by-field mapping):
//   - notebooks.is_system, created_at/updated_at
//   - discussions.parent_id (unused anywhere in this app today, and has
//     no equivalent in pact-mac's discussions type either),
//     draft_prompt_text (drafts aren't part of pact-mac's export concept)
//   - responses.image_path / image_mime_type (no equivalent in pact-mac's
//     cells type; currently unused by any feature in this app, so
//     nothing is silently lost in practice today)
//   - category is round-tripped as an opaque string, not validated
//     against pact-mac's "personal-research" | "samples" | "dev-tests" |
//     "user-requests" union -- this app's real category values
//     ("Personal Research", "Dev Test") are a different naming scheme
//     entirely, so coercing between them would be arbitrary and lossy.

export const PACT_EXPORT_VERSION = 1;

export interface PactExportCell {
  id: string;
  discussionId: string;
  parentId: string | null;
  promptText: string;
  response: string;
  model: string;
  resolvedModel?: string | null;
  cellType: string;
  createdAt: number;
}

export interface PactExportDiscussion {
  id: string;
  name: string;
  createdAt: number;
  totalTimeMs: number;
}

export interface PactExport {
  version: number;
  exportedAt: number;
  notebook: {
    name: string;
    systemPrompt: string | null;
    category?: string | null;
    // Task 55d. The notebook's total measured run time, summed from its
    // discussions' own totalTimeMs at export time.
    //
    // Persisted in the file even though the live view derives it on
    // read, because the file has to answer "how long did this take?"
    // a month later with no database behind it -- and be readable by a
    // human opening the raw JSON. That is the opposite trade-off from
    // the live rollup, and deliberately so.
    //
    // Optional, so PACT_EXPORT_VERSION stays at 1: files written before
    // this simply lack it, and pact-mac ignores what it does not read.
    // Verified, not assumed -- pact-mac's importNotebook (pact-
    // production/src/storage/notebookStore.ts) accesses only
    // data.notebook.name and .systemPrompt by direct property read,
    // with no schema validation. pact-web has in fact been sending it
    // an unrecognised notebook-level `category` all along.
    totalTimeMs?: number;
  };
  discussions: PactExportDiscussion[];
  cells: PactExportCell[];
}

class PactExportValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PactExportValidationError(`${field} must be a string.`);
  }
  return value;
}

// Stricter than requireString for the two identifying names this format
// carries (notebook.name, discussions[].name): a real, well-formed
// export can never contain an empty one -- both creation paths this app
// has (the manual create forms, and now the unique-discussion-name
// constraint) already reject that at the source. An empty string only
// ever reaches here via a hand-edited or otherwise malformed file, and
// letting it through used to mean the imported row displayed its own
// raw uuid in the Explorer tree in place of a name (Explorer.tsx's
// name-or-id fallback existed for exactly this reason) -- closed here,
// at the one place that can actually prevent it from being created,
// rather than only papering over it at display time.
function requireNonEmptyString(value: unknown, field: string): string {
  const str = requireString(value, field);
  if (str.trim().length === 0) {
    throw new PactExportValidationError(
      `${field} must not be empty or whitespace-only.`,
    );
  }
  return str;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field);
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PactExportValidationError(`${field} must be a number.`);
  }
  return value;
}

// Absent stays absent rather than defaulting to 0. A file written
// before task 55d has no measurement to report, and 0 would assert a
// measured zero -- which is exactly the "reads as broken" confusion the
// rollup work set out to avoid.
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return requireNumber(value, field);
}

// Validates and narrows an arbitrary parsed-JSON value into a PactExport,
// throwing PactExportValidationError with a specific, human-readable
// message for the first thing that's wrong -- a malformed file should
// fail clearly, not crash cryptically partway through import.
export function validatePactExport(data: unknown): PactExport {
  if (!isPlainObject(data)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: expected a JSON object.",
    );
  }

  // Task 77: JSON with neither a version nor a notebook is not a .pact
  // file at all -- say that, rather than "unsupported version undefined".
  if (data.version === undefined && data.notebook === undefined) {
    throw new PactExportValidationError(
      "Not a .pact file: it has no format version and no notebook.",
    );
  }

  if (data.version !== PACT_EXPORT_VERSION) {
    throw new PactExportValidationError(
      `Unsupported .pact file version: expected ${PACT_EXPORT_VERSION}, got ${JSON.stringify(data.version)}.`,
    );
  }

  if (!isPlainObject(data.notebook)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: missing notebook object.",
    );
  }
  const notebook = {
    name: requireNonEmptyString(data.notebook.name, "notebook.name"),
    systemPrompt: requireNullableString(
      data.notebook.systemPrompt,
      "notebook.systemPrompt",
    ),
    category: requireNullableString(
      data.notebook.category,
      "notebook.category",
    ),
    // Allow-listed explicitly: this validator rebuilds the notebook
    // object field by field, so anything not named here is dropped on
    // import. Without this line the field would export correctly and
    // then vanish on the way back in.
    totalTimeMs: optionalNumber(
      data.notebook.totalTimeMs,
      "notebook.totalTimeMs",
    ),
  };

  if (!Array.isArray(data.discussions)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: discussions must be an array.",
    );
  }
  const discussions: PactExportDiscussion[] = data.discussions.map(
    (raw, index) => {
      if (!isPlainObject(raw)) {
        throw new PactExportValidationError(
          `Not a valid .pact file: discussions[${index}] is not an object.`,
        );
      }
      return {
        id: requireString(raw.id, `discussions[${index}].id`),
        name: requireNonEmptyString(raw.name, `discussions[${index}].name`),
        createdAt: requireNumber(
          raw.createdAt,
          `discussions[${index}].createdAt`,
        ),
        totalTimeMs: requireNumber(
          raw.totalTimeMs,
          `discussions[${index}].totalTimeMs`,
        ),
      };
    },
  );
  const discussionIds = new Set(discussions.map((d) => d.id));

  if (!Array.isArray(data.cells)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: cells must be an array.",
    );
  }
  const cells: PactExportCell[] = data.cells.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new PactExportValidationError(
        `Not a valid .pact file: cells[${index}] is not an object.`,
      );
    }
    const discussionId = requireString(
      raw.discussionId,
      `cells[${index}].discussionId`,
    );
    if (!discussionIds.has(discussionId)) {
      throw new PactExportValidationError(
        `Not a valid .pact file: cells[${index}].discussionId does not match any discussion in this file.`,
      );
    }
    return {
      id: requireString(raw.id, `cells[${index}].id`),
      discussionId,
      parentId: requireNullableString(raw.parentId, `cells[${index}].parentId`),
      promptText: requireString(raw.promptText, `cells[${index}].promptText`),
      response: requireString(raw.response, `cells[${index}].response`),
      model: requireString(raw.model, `cells[${index}].model`),
      resolvedModel: requireNullableString(
        raw.resolvedModel,
        `cells[${index}].resolvedModel`,
      ),
      cellType: requireString(raw.cellType, `cells[${index}].cellType`),
      createdAt: requireNumber(raw.createdAt, `cells[${index}].createdAt`),
    };
  });

  return {
    version: data.version,
    exportedAt:
      typeof data.exportedAt === "number" ? data.exportedAt : Date.now(),
    notebook,
    discussions,
    cells,
  };
}

// Task 77. Reading .pact files written by older PACT apps.
//
// Measured across the 95 .pact files on Nik's machine (2026-10-04): every
// one is format version 1, in one of two wrappings.
//   - Plain: the format above. Written by pact-web, pact-mac, the VSCode
//     extension and the legacy app over time, with optional fields coming
//     and going (category, resolvedModel, totalTimeMs) and older model
//     names ("claude", "claude-sonnet", "gpt"). validatePactExport already
//     accepted all 56 of these.
//   - Signed: { version, payload, signature, signedAt, signer }, where
//     payload is a plain export. Written by pact-mac / the extension
//     (signer "pact-local") and the legacy app (signer
//     "pactresearch.net"). All 36 were rejected before this.
//
// Some fields have no home in pact-web: the signature, pact-mac's
// desktop navigation state (xmState) and notebook execution mode
// (executionMode -- pact-web is interactive-only, see the header). They
// are not imported, but they are never dropped silently: readPactFile
// names every field it leaves behind, and the import route returns that
// list so the user is told.

export interface PactImport {
  pactExport: PactExport;
  /** Human-readable, one entry per field from the file that is not kept. */
  notCarriedOver: string[];
}

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

function describeDropped(path: string, value: unknown): string {
  if (path === "xmState") {
    return "xmState: the desktop app's navigation state (open discussion, scroll positions). pact-web has no equivalent.";
  }
  if (path === "notebook.executionMode") {
    return `notebook.executionMode ("${String(value)}"): pact-web notebooks are interactive-only, so the mode is not kept.`;
  }
  return `${path}: not part of pact-web's notebook format.`;
}

function unknownKeys(
  value: unknown,
  known: string[],
  pathPrefix: string,
): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .filter((key) => !known.includes(key))
    .map((key) => describeDropped(`${pathPrefix}${key}`, value[key]));
}

// Unknown keys across an array's items, reported once per key with how
// many items carried it -- one line, not one per cell.
function unknownItemKeys(
  items: unknown,
  known: string[],
  label: string,
): string[] {
  if (!Array.isArray(items)) return [];
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    for (const key of Object.keys(item)) {
      if (!known.includes(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(
    ([key, n]) =>
      `${label}.${key} (in ${n} of ${items.length}): not part of pact-web's notebook format.`,
  );
}

export function readPactFile(data: unknown): PactImport {
  const notCarriedOver: string[] = [];
  let body: unknown = data;

  if (isPlainObject(data) && "payload" in data && "signature" in data) {
    if (data.version !== PACT_EXPORT_VERSION) {
      throw new PactExportValidationError(
        `Unsupported signed .pact file version: expected ${PACT_EXPORT_VERSION}, got ${JSON.stringify(data.version)}.`,
      );
    }
    let payload: unknown = data.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new PactExportValidationError(
          "Not a valid .pact file: its signed payload is not readable JSON.",
        );
      }
    }
    if (!isPlainObject(payload)) {
      throw new PactExportValidationError(
        "Not a valid .pact file: its signed payload is missing.",
      );
    }
    // The signer is a short label ("pact-local", "pactresearch.net"), not
    // a key; anything else is not echoed back.
    const signer =
      typeof data.signer === "string" && /^[\w.-]{1,40}$/.test(data.signer)
        ? data.signer
        : "an unknown signer";
    notCarriedOver.push(
      `The file's signature (signed by ${signer}): pact-web does not verify or keep .pact signatures.`,
    );
    for (const key of Object.keys(data)) {
      if (
        !["version", "payload", "signature", "signedAt", "signer"].includes(key)
      ) {
        notCarriedOver.push(describeDropped(key, data[key]));
      }
    }
    body = payload;
  }

  if (isPlainObject(body)) {
    notCarriedOver.push(
      ...unknownKeys(body, KNOWN_TOP, ""),
      ...unknownKeys(body.notebook, KNOWN_NOTEBOOK, "notebook."),
      ...unknownItemKeys(body.discussions, KNOWN_DISCUSSION, "discussions"),
      ...unknownItemKeys(body.cells, KNOWN_CELL, "cells"),
    );
  }

  return { pactExport: validatePactExport(body), notCarriedOver };
}

export { PactExportValidationError };
