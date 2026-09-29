// Task 65 follow-up. The click-to-download half of per-discussion
// export, shared by the two places that offer it: the discussion row's
// menu in the Explorer, and the Export button on the active-discussion
// header. Two copies of this would drift, and the thing they would
// drift on -- which endpoint, which filename, which MIME type -- is
// exactly what a user would notice.
//
// Browser-only (it needs document and URL.createObjectURL), so it lives
// apart from lib/discussionMarkdown.ts, which is pure and runs on the
// server.
//
// Returns false rather than throwing: both callers want to show their
// own inline message next to their own control, and neither wants an
// unhandled rejection if the network drops. The route's own error body
// is deliberately not surfaced -- callers phrase the failure in terms
// of the discussion the user clicked on, which is more use than a
// status code.
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

  const url = URL.createObjectURL(
    new Blob([payload.markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  // The server names the file, so the convention lives in exactly one
  // place (lib/discussionMarkdown.ts) rather than here and there.
  link.download = payload.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
}
