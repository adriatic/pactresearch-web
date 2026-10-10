import { getBuildInfo } from "@/lib/buildInfo";

// The deployed build, visible without asking anyone.
//
// A server component with no "use client": it reads Vercel's
// server-side system env vars directly, so nothing is baked into the
// client bundle and a cached bundle can never show a stale SHA.
//
// Rendered from the root layout, so it is on every page INCLUDING the
// login screen. That is deliberate rather than incidental: it means a
// deployed build can be identified without credentials, which is how
// a Preview deploy gets checked at all.
//
// Bottom-left, because "Report a problem" already occupies the
// bottom-right. Small, quiet, and out of the way -- and deliberately not
// a dialog: the task asked for something you can glance at, not
// something you have to dismiss.
export function BuildBadge() {
  const { label, fullSha, commitUrl, environment } = getBuildInfo();

  const shared = {
    position: "fixed" as const,
    left: 6,
    bottom: 4,
    zIndex: 900,
    // Task 73. Was #888 at opacity 0.65 and 0.7em: about rgb(178,178,178)
    // on white, a contrast of roughly 2:1 at 11px -- easy to miss even
    // when you know where to look (the comment here said it "lifts on
    // hover", but inline styles cannot, so it never did). Now #666 at
    // full strength, 5.7:1 (the usual floor for small text is 4.5:1),
    // and a little larger. Still grey, small and in the corner: it is
    // readable at a glance, not competing with the controls.
    fontSize: "0.75em",
    fontFamily: "monospace",
    color: "#666",
    background: "rgba(255, 255, 255, 0.85)",
    padding: "1px 4px",
    borderRadius: 3,
  };

  // The title carries the FULL sha: the short one is for reading, the
  // full one is what gets pasted into a bug report or git command.
  // Task 73: says what the badge is, for anyone who notices it without
  // being told. Hover text only on a Mac; the label itself must stand
  // on its own on an iPad.
  const title = fullSha
    ? `The version of pact-web you are using. Build ${fullSha}${environment ? ` (${environment})` : ""}`
    : "The version of pact-web you are using. No build commit available";

  if (!commitUrl) {
    // Still rendered, still selectable and copyable -- only the link is
    // missing, because the repo coordinates were not available.
    return (
      <span data-build-label style={shared} title={title}>
        {label}
      </span>
    );
  }

  return (
    <a
      data-build-label
      href={commitUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ...shared, textDecoration: "none" }}
      title={`${title} — open the commit on GitHub`}
    >
      {label}
    </a>
  );
}
