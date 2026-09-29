import { normalizeLatexDelimiters } from "./latexDelimiters";

// Task 65. Renders one discussion as a self-contained markdown document.
//
// Deliberately NOT the .pact format. A .pact file is structured JSON
// carrying ids, timestamps, model names and timing data, and exists to
// round-trip back into pact-web or pact-mac. A single discussion someone
// exports is usually going somewhere else entirely -- an email, a doc,
// a reader who has never seen this app -- where none of that means
// anything. So: no ids, no millisecond timings, no model internals.
//
// Pure and I/O-free on purpose, so the exact bytes of the file can be
// asserted in a unit test rather than only observed through a download.

export interface DiscussionMarkdownTurn {
  // Already markdown: the route converts a rich prompt through
  // lib/discussionPromptMarkdown before it gets here.
  prompt: string;
  // null or blank for a turn that is still running or that failed.
  response: string | null;
}

export interface DiscussionMarkdownInput {
  discussionName: string;
  notebookName: string;
  exportedAt: Date;
  turns: DiscussionMarkdownTurn[];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Formatted from explicit UTC parts rather than toLocaleDateString: the
// server that renders this runs in UTC, and a locale-dependent string
// would make the tests depend on the machine that ran them.
function formatHeaderDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Content goes in verbatim apart from one transformation: LaTeX written
// as \(...\) / \[...\] becomes the dollar form, the same rewrite the
// response panel does, so an equation that typesets in the app also
// typesets in whatever the reader opens the file with. Inline math uses
// "$...$" here rather than the app's "$$...$$" -- see the note in
// lib/latexDelimiters.ts for why the two differ on that one point.
//
// Nothing else is escaped or re-wrapped. A response that came back with
// a fenced code block, a table or a list is already markdown, and the
// job here is to frame it, not to re-encode it.
function body(text: string): string {
  return normalizeLatexDelimiters(text.trim(), "$");
}

const NO_RESPONSE = "_No response recorded — this turn did not complete._";

export function renderDiscussionMarkdown({
  discussionName,
  notebookName,
  exportedAt,
  turns,
}: DiscussionMarkdownInput): string {
  const parts: string[] = [
    `# ${discussionName}`,
    "",
    `From notebook **${notebookName}** · exported ${formatHeaderDate(exportedAt)}`,
  ];

  if (turns.length === 0) {
    parts.push("", "---", "", "_This discussion has no turns yet._", "");
    return parts.join("\n");
  }

  turns.forEach((turn, index) => {
    // The blank line before "---" matters: without it, a horizontal rule
    // directly under a line of text is read as a setext heading
    // underline and would swallow the last line of the turn above.
    parts.push("", "---", "", `## Turn ${index + 1}`, "");
    parts.push("**Prompt**", "");
    parts.push(body(turn.prompt) || "_(empty prompt)_", "");
    parts.push("**Response**", "");
    const response = (turn.response ?? "").trim();
    // An in-flight or failed turn is marked, not dropped. Dropping it
    // would lose the prompt the user actually wrote, and rendering it as
    // an empty response would read as "the model said nothing".
    parts.push(response.length > 0 ? body(response) : NO_RESPONSE);
  });

  parts.push("");
  return parts.join("\n");
}

// Identifiable in a downloads folder without opening it: the discussion's
// own name, then the date. ISO order, not a locale one, for the same
// reason the header date is built by hand -- it also sorts correctly in
// a file listing. Two exports on the same day share a name; the browser
// disambiguates those itself, and a timestamp precise enough to avoid it
// would be exactly the kind of metadata this format is trying to drop.
export function discussionExportFilename(
  discussionName: string,
  exportedAt: Date,
): string {
  const safeName = discussionName
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeName || "discussion"}-${isoDate(exportedAt)}.md`;
}
