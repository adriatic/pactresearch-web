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
