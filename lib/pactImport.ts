// Task 79. Importing several .pact files at once -- from the Import button,
// from a drop onto the window, or (Chrome and similar) from the newer file
// chooser that remembers the last folder.
//
// Every file goes through the existing import route, unchanged, one after
// another: each notebook stays all-or-nothing (main 22111de) and one bad
// file never stops the rest. The result is a short summary in plain words
// -- how many imported, and for each that did not, its name and a reason
// a person can act on. No error codes, no server messages.

export type ImportOutcome =
  | { file: string; ok: true; notebookName: string }
  | { file: string; ok: false; reason: string };

export const REASONS = {
  notPact: "Not a .pact file, so it was left out.",
  damaged: "The file is damaged or incomplete.",
  olderFormat:
    "This file is in an older PACT format. Convert it with the PACT converter first.",
  notNotebook: "This is not a PACT notebook file.",
  invalid: "This file is not a valid PACT notebook.",
  signedOut: "You are signed out. Sign in again, then import it again.",
  serverFailed:
    "Something went wrong while saving it. Nothing from this file was saved.",
  unreachable:
    "pact-web could not be reached. Nothing from this file was saved.",
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The older signed format the converter (tools/pact-convert) handles. */
export function isOlderSignedFormat(parsed: unknown): boolean {
  return isObject(parsed) && "payload" in parsed && "signature" in parsed;
}

/** A plain reason for a refusal from the import route. */
export function reasonForRefusal(
  parsed: unknown,
  status: number,
  serverError: unknown,
): string {
  if (status === 401) return REASONS.signedOut;
  if (status >= 500) return REASONS.serverFailed;
  if (isOlderSignedFormat(parsed)) return REASONS.olderFormat;
  const message = typeof serverError === "string" ? serverError : "";
  if (
    !isObject(parsed) ||
    /Unsupported \.pact file version|missing notebook object|expected a JSON object/.test(
      message,
    )
  ) {
    return REASONS.notNotebook;
  }
  return REASONS.invalid;
}

export type PostImport = (
  parsed: unknown,
) => Promise<{ status: number; body: unknown }>;

/**
 * Imports files one after another through `post` (the existing route).
 * Never throws: every file ends as one outcome, in the order given.
 */
export async function importPactFiles(
  files: File[],
  post: PostImport,
  onProgress?: (done: number, total: number) => void,
  // Drops only (part C): anything dropped that is not named .pact is left
  // out. The Import button keeps deciding by content, as before -- a
  // chosen file is not refused for its name.
  { requirePactName = false }: { requirePactName?: boolean } = {},
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (requirePactName && !file.name.toLowerCase().endsWith(".pact")) {
      outcomes.push({ file: file.name, ok: false, reason: REASONS.notPact });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      outcomes.push({ file: file.name, ok: false, reason: REASONS.damaged });
      continue;
    }
    try {
      const { status, body } = await post(parsed);
      if (status >= 200 && status < 300) {
        const name =
          isObject(body) && typeof body.name === "string" ? body.name : "";
        outcomes.push({ file: file.name, ok: true, notebookName: name });
      } else {
        outcomes.push({
          file: file.name,
          ok: false,
          reason: reasonForRefusal(
            parsed,
            status,
            isObject(body) ? body.error : undefined,
          ),
        });
      }
    } catch {
      outcomes.push({
        file: file.name,
        ok: false,
        reason: REASONS.unreachable,
      });
    }
  }
  return outcomes;
}

export interface ImportSummary {
  headline: string;
  problems: { file: string; reason: string }[];
}

export function summarizeImport(outcomes: ImportOutcome[]): ImportSummary {
  const total = outcomes.length;
  const imported = outcomes.filter((o) => o.ok).length;
  const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
  const headline =
    imported === total
      ? `Imported ${files(total)}.`
      : imported === 0
        ? total === 1
          ? "The file could not be imported."
          : `None of the ${total} files could be imported.`
        : `Imported ${imported} of ${files(total)}.`;
  return {
    headline,
    problems: outcomes.flatMap((o) =>
      o.ok ? [] : [{ file: o.file, reason: o.reason }],
    ),
  };
}

// Part D: the newer file chooser (showOpenFilePicker), Chrome and similar.
// Detected by feature, never by browser name. Safari and the iPad do not
// have it and keep the plain file input exactly as before.

interface FilePickerWindow {
  showOpenFilePicker?: (
    options: unknown,
  ) => Promise<{ getFile: () => Promise<File> }[]>;
}

export function supportsOpenFilePicker(win: unknown): boolean {
  return (
    isObject(win) &&
    typeof (win as FilePickerWindow).showOpenFilePicker === "function"
  );
}

/** The same id every time, so the chooser reopens in the last folder used. */
export const PICKER_OPTIONS = {
  id: "pact-import",
  startIn: "documents",
  multiple: true,
  types: [
    {
      description: "PACT notebooks",
      accept: { "application/octet-stream": [".pact"] },
    },
  ],
  excludeAcceptAllOption: false,
} as const;

/**
 * Opens the newer chooser. Returns the chosen files, or [] when the person
 * cancels (no error shown). Only call when supportsOpenFilePicker is true.
 */
export async function pickPactFiles(win: unknown): Promise<File[]> {
  const picker = (win as FilePickerWindow).showOpenFilePicker!;
  try {
    const handles = await picker.call(win, PICKER_OPTIONS);
    return await Promise.all(handles.map((h) => h.getFile()));
  } catch (error) {
    if (isObject(error) && error.name === "AbortError") return [];
    if (error instanceof DOMException && error.name === "AbortError") return [];
    throw error;
  }
}
