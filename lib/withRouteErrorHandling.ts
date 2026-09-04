// Shared safety net for Route Handlers. The routes themselves already
// return explicit 401/400/404/409 (and their own specific 500s) directly —
// this only ever fires for something actually unexpected (a genuine
// DB/network failure surfaced via `if (error) throw error;`), converting it
// into a clean JSON 500 instead of Next's generic error page, without
// leaking the underlying error's message or details to the client.
type RouteHandler<Args extends unknown[]> = (
  ...args: Args
) => Promise<Response>;

export function withRouteErrorHandling<Args extends unknown[]>(
  handler: RouteHandler<Args>,
): RouteHandler<Args> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: "Internal server error." },
        { status: 500 },
      );
    }
  };
}
