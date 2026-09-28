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
// bottom-right. Small, dim, and out of the way -- and deliberately not
// a dialog: the task asked for something you can glance at, not
// something you have to dismiss.
export function BuildBadge() {
  const { label, fullSha, commitUrl, environment } = getBuildInfo();

  const shared = {
    position: "fixed" as const,
    left: 6,
    bottom: 4,
    zIndex: 900,
    fontSize: "0.7em",
    fontFamily: "monospace",
    color: "#888",
    // Unobtrusive until wanted: it sits over the sidebar's lower
    // panel, so it stays faint and lifts on hover rather than
    // competing with the controls underneath.
    opacity: 0.65,
    background: "rgba(255, 255, 255, 0.85)",
    padding: "1px 4px",
    borderRadius: 3,
  };

  // The title carries the FULL sha: the short one is for reading, the
  // full one is what gets pasted into a bug report or git command.
  const title = fullSha
    ? `Build ${fullSha}${environment ? ` (${environment})` : ""}`
    : "No build commit available";

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
