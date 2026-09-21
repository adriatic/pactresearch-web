import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

// Same-origin, session-cookie-authenticated proxy for images stored in the
// private prompt-images bucket -- chosen over a Supabase signed URL
// specifically to stay consistent with how every other piece of data in
// this app is accessed (a Next.js route using the session-scoped client),
// rather than introducing signed-URL expiry management as a one-off
// exception. A Tiptap image node's `src` is set to
// /api/prompt-images/<user_id>/<discussion_id>/<uuid>.<ext> -- an
// ordinary same-origin <img src>, riding the browser's existing session
// cookie with no extra token plumbing.
async function handleGet(
  _request: Request,
  context: RouteContext<"/api/prompt-images/[...path]">,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await context.params;
  const storagePath = path.join("/");

  // Defense in depth: RLS on storage.objects already confines the
  // download below to the caller's own path prefix -- this is just a
  // cheap, friendly 404 ahead of that, not the real enforcement boundary.
  if (!storagePath.startsWith(`${user.id}/`)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const { data, error } = await supabase.storage
    .from("prompt-images")
    .download(storagePath);

  if (error || !data) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  return new Response(data, {
    headers: {
      "content-type": data.type || "application/octet-stream",
      // Object names are random UUIDs, never reused -- safe to cache
      // aggressively and immutably once fetched once.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

export const GET = withRouteErrorHandling(handleGet);
