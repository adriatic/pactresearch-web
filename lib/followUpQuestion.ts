// Task 49. Pulls the assistant's own trailing follow-up question out of a
// response, so the composer's placeholder can show what the user is
// replying to instead of the generic hint.
//
// Deliberately conservative. A wrong or half-parsed question in the
// placeholder is worse than no question at all -- the user would be
// answering something the assistant did not ask. Every rule below is a
// reason to return null rather than guess.

// Long enough that a truncated placeholder would be the norm rather than
// the exception, and at that length the user is better served scrolling
// up and reading the real thing.
const MAX_LENGTH = 200;
// Shorter than this is not a question worth surfacing ("Ok?"), and is
// more likely to be a parsing artefact than a real ask.
const MIN_LENGTH = 8;

// Markdown that can sit at the START of the final line: blockquote
// markers, list bullets, ordered-list numbers, heading hashes.
const LEADING_MARKERS = /^\s*(?:[>#]+\s*|[-*+]\s+|\d+[.)]\s+)/;

function stripInlineMarkdown(text: string): string {
  return (
    text
      // links: [label](url) -> label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // emphasis / inline code markers, left as their own content
      .replace(/[*_`~]/g, "")
      .trim()
  );
}

export function extractFollowUpQuestion(response: string): string | null {
  if (!response) return null;

  // Fenced code blocks first: a "?" inside sample code or output is not
  // the assistant asking the user anything. Removing whole fences also
  // stops an unterminated one from swallowing the real ending.
  const withoutFences = response.replace(/```[\s\S]*?```/g, "\n");

  const lines = withoutFences
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const lastLine = stripInlineMarkdown(
    lines[lines.length - 1].replace(LEADING_MARKERS, ""),
  );
  if (!lastLine.endsWith("?")) return null;

  // The last SENTENCE of that line, not the whole line. The case this
  // feature exists for reads "You're doing the right thing by her. What's
  // happening with her care needs?" -- surfacing only the question is the
  // point; the sentence before it is reassurance, not an ask.
  //
  // Split after ., ! or ? followed by whitespace. Abbreviations ("e.g. ")
  // can split early, which costs at worst a slightly short question and
  // never a wrong one, since the final segment always ends at the real
  // "?" anyway.
  const sentences = lastLine.split(/(?<=[.!?])\s+/);
  const question = sentences[sentences.length - 1].trim();

  if (question.length < MIN_LENGTH || question.length > MAX_LENGTH) {
    return null;
  }
  // A bare "?" or a string of punctuation is not a question.
  if (!/[A-Za-z]/.test(question)) return null;

  return question;
}

// The composer placeholder shown while replying to a specific question.
// Quoted so it reads as the assistant's words rather than an instruction
// to the user.
export function followUpPlaceholder(question: string): string {
  return `Reply to: "${question}"`;
}
