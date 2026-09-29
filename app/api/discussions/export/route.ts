import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";
import {
  discussionExportFilename,
  renderDiscussionMarkdown,
  type DiscussionMarkdownTurn,
} from "@/lib/discussionMarkdown";
import { promptToMarkdown } from "@/lib/discussionPromptMarkdown";
import type { RichContent } from "@/lib/richContent";

// Task 65. Per-discussion export, markdown rather than .pact -- see
// lib/discussionMarkdown.ts for why the format differs from the
// notebook-level export next door.
//
// Returns JSON { filename, markdown } rather than a text/markdown body
// with Content-Disposition. Two reasons: it is the same shape
// /api/notebooks/export already uses (the client builds the Blob and
// triggers the download either way), and it keeps ONE implementation of
// the filename convention instead of a server header plus a client-side
// fallback that would have to agree with it.
async function handleGet(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const discussionId = searchParams.get("id");
  if (!discussionId) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }

  // Session-scoped client + RLS: this can only ever find a discussion the
  // caller owns, so another user's id is indistinguishable from one that
  // does not exist -- the same non-distinguishing 404 the notebook export
  // and DELETE /api/discussions use. The embedded notebooks(name) is
  // covered by the same policy on notebooks.
  const { data: discussion, error: discussionError } = await supabase
    .from("discussions")
    .select("name, notebooks(name)")
    .eq("id", discussionId)
    .maybeSingle();
  if (discussionError) {
    throw discussionError;
  }
  if (!discussion) {
    return Response.json({ error: "Discussion not found." }, { status: 404 });
  }

  // Scoped to this discussionId alone. A notebook's other discussions
  // must not leak into a file the user believes holds one conversation.
  //
  // Oldest first with id breaking ties -- the same ordering task 60 had
  // to fix in the tree and the notebook export, and that task 62's
  // history read uses. A conversation exported out of order is worse
  // than not exporting it.
  const { data: responseRows, error: responsesError } = await supabase
    .from("responses")
    .select("prompt_text, prompt_content, response, created_at, id")
    .eq("discussion_id", discussionId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (responsesError) {
    throw responsesError;
  }

  const turns: DiscussionMarkdownTurn[] = (responseRows ?? []).map((row) => ({
    prompt: promptToMarkdown(
      (row.prompt_content as RichContent | null) ?? null,
      row.prompt_text ?? "",
    ),
    response: row.response,
  }));

  const exportedAt = new Date();
  // PostgREST returns a to-one embed as an object, but the generated
  // types describe it as an array (it cannot tell one-to-one from
  // one-to-many from the schema alone). Handled both ways rather than
  // cast away, so a type change cannot turn into a wrong notebook name.
  const embedded = discussion.notebooks as
    { name: string } | { name: string }[] | null;
  const notebook = Array.isArray(embedded) ? embedded[0] : embedded;

  return Response.json({
    filename: discussionExportFilename(discussion.name, exportedAt),
    markdown: renderDiscussionMarkdown({
      discussionName: discussion.name,
      // A discussion always has a notebook (NOT NULL foreign key), but
      // the embed is typed as nullable, so this names the gap rather
      // than asserting it away.
      notebookName: notebook?.name ?? "Unknown notebook",
      exportedAt,
      turns,
    }),
  });
}

export const GET = withRouteErrorHandling(handleGet);
