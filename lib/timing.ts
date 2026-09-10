// Server-side timing for the queries on the discussion-switch hot path
// (GET /api/discussions, PATCH /api/discussions, GET /api/responses) — logs
// how long each Supabase round trip actually took, so a slow switch can be
// traced to a specific query rather than guessed at from the client's
// aggregate fetch duration. `label` is per-request (includes the relevant
// id), not a fixed string, since Vercel can interleave logs from concurrent
// invocations in the same stream.
export async function timed<T>(
  label: string,
  fn: () => PromiseLike<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(
      `[timing] ${label}: ${(performance.now() - start).toFixed(1)}ms`,
    );
  }
}

// Broader companion to `timed` above: that one only ever covered the
// Supabase query itself, leaving everything else in a handler (the auth
// check, JSON parsing, response serialization) invisible — a real gap
// surfaced when a logged ~469ms of query time couldn't account for an
// observed 3.1s client-side switch. This wraps the *entire* handler
// execution, from before the auth check to the returned Response, and
// lets the handler record named sub-phases (auth check, etc.) via
// `timer.mark`, so a log line can show auth/query/total side by side
// instead of only ever being able to time the query in isolation.
export interface HandlerTimer {
  // Records a named phase's own duration (in ms) — the handler measures
  // the phase itself (e.g. around `auth.getUser()`) and reports it here;
  // this doesn't do the timing, just collects it for the summary line.
  mark(phase: string, durationMs: number): void;
  // Lets the handler refine the summary line's label once it knows
  // request-specific detail (e.g. the discussion id) that isn't known
  // until partway through — matches `timed`'s existing per-request label
  // convention so the two log lines stay comparable.
  setLabel(label: string): void;
}

export function withFullTiming<Args extends unknown[]>(
  baseLabel: string,
  handler: (timer: HandlerTimer, ...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const start = performance.now();
    const phases: Record<string, number> = {};
    let label = baseLabel;
    const timer: HandlerTimer = {
      mark(phase, durationMs) {
        phases[phase] = durationMs;
      },
      setLabel(newLabel) {
        label = newLabel;
      },
    };
    try {
      return await handler(timer, ...args);
    } finally {
      const total = (performance.now() - start).toFixed(1);
      const phaseStr = Object.entries(phases)
        .map(([phase, durationMs]) => `${phase}=${durationMs.toFixed(1)}ms`)
        .join(" ");
      console.log(
        `[timing-full] ${label}: ${phaseStr ? phaseStr + " " : ""}total=${total}ms`,
      );
    }
  };
}
