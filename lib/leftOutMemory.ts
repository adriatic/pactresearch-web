// Task 71. Remembers, in this browser, how many of the oldest turns each
// answer's request left out, so the grey note under that answer survives
// switching discussions and reloading the page. The count is not stored
// on the server (that would need a database change); this keeps it where
// the person who asked can see it again.
//
// Browser storage can be missing or refuse (private windows, blocked site
// data), so every access is guarded and the page works without it -- the
// note then shows for the current visit only, as before.

const KEY = "pact.historyLeftOut";
const LIMIT = 500;

type Memory = Record<string, number>;

function read(): Memory {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Memory) : {};
  } catch {
    return {};
  }
}

export function rememberLeftOut(responseId: string, count: number): void {
  if (!(count > 0)) return;
  try {
    const memory = read();
    delete memory[responseId];
    memory[responseId] = count;
    const ids = Object.keys(memory);
    for (const old of ids.slice(0, Math.max(0, ids.length - LIMIT))) {
      delete memory[old];
    }
    window.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Not remembered; the note still shows for this visit.
  }
}

export function withRememberedLeftOut<
  T extends { id: string; turns_left_out?: number },
>(entries: T[]): T[] {
  const memory = read();
  return entries.map((e) =>
    memory[e.id] > 0 ? { ...e, turns_left_out: memory[e.id] } : e,
  );
}
