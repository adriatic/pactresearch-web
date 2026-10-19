// Task 65 follow-up. The click-to-download half of per-discussion
// export, used by the discussion row's menu in the Explorer. (It was
// shared with an Export button on the active-discussion header until
// Task 96 removed that button.)
//
// Browser-only (its last step, lib/saveOrShareFile.ts, needs the
// document or the share sheet), so it lives apart from
// lib/discussionMarkdown.ts, which is pure and runs on the server.
//
// Returns false rather than throwing: the caller shows its own inline
// message, and does not want an unhandled rejection if the network
// drops. The route's own error body is deliberately not surfaced -- the
// caller phrases the failure in terms of the discussion the user
// clicked on, which is more use than a status code.
import { saveOrShareFile } from "@/lib/saveOrShareFile";

export async function downloadDiscussionExport(
  discussionId: string,
): Promise<boolean> {
  let payload: { filename: string; markdown: string };
  try {
    const response = await fetch(
      `/api/discussions/export?id=${encodeURIComponent(discussionId)}`,
    );
    if (!response.ok) return false;
    payload = await response.json();
  } catch {
    return false;
  }

  // The server names the file, so the convention lives in exactly one
  // place (lib/discussionMarkdown.ts) rather than here and there.
  const file = new File([payload.markdown], payload.filename, {
    type: "text/markdown;charset=utf-8",
  });
  // Task 100: share sheet on an iPad or iPhone, download elsewhere. A
  // cancelled sheet still counts as success: no error message for it.
  try {
    await saveOrShareFile(file);
  } catch {
    return false;
  }
  return true;
}
