// Which build am I looking at?
//
// Vercel injects its system environment variables at build AND run time
// for both Production and Preview, with no dashboard configuration and
// no secret to manage. This reads them SERVER-side, deliberately:
//
//   - The unprefixed VERCEL_* variables are server-only. The
//     NEXT_PUBLIC_VERCEL_* mirrors exist only while Vercel's
//     "automatically expose System Environment Variables" setting is
//     on, which is a dashboard toggle nobody here has verified and
//     which would silently produce "unknown" if it were ever off.
//     Reading the server-side names removes that dependency.
//
//   - Reading it server-side also means nothing is baked into the
//     client bundle at build time, so a cached bundle can never serve a
//     stale SHA. The layout is a server component and re-renders per
//     request.
//
// Pure and env-injected so the label logic can be unit tested without a
// deployment.

export interface BuildInfo {
  /** Short SHA, or null when there is no commit to report. */
  shortSha: string | null;
  fullSha: string | null;
  /** Vercel's own name: "production" | "preview" | "development". */
  environment: string | null;
  /** What actually gets rendered. */
  label: string;
  /** Link to the commit, when the repo coordinates are known. */
  commitUrl: string | null;
}

const SHORT_SHA_LENGTH = 7;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function buildInfoFrom(
  env: Record<string, string | undefined>,
): BuildInfo {
  const fullSha = env.VERCEL_GIT_COMMIT_SHA || null;
  const shortSha = fullSha ? fullSha.slice(0, SHORT_SHA_LENGTH) : null;
  const environment = env.VERCEL_ENV || null;

  const owner = env.VERCEL_GIT_REPO_OWNER;
  const slug = env.VERCEL_GIT_REPO_SLUG;
  const commitUrl =
    fullSha && owner && slug
      ? `https://github.com/${owner}/${slug}/commit/${fullSha}`
      : null;

  // Not running on Vercel at all -- a developer's machine. Saying so is
  // the honest answer; inventing a version would be worse than none.
  if (!environment) {
    return {
      shortSha,
      fullSha,
      environment: null,
      label: shortSha ? `Local · ${shortSha}` : "Local dev",
      commitUrl,
    };
  }

  // On Vercel but with no commit SHA. This should not happen, and the
  // task was explicit that a placeholder must not quietly stand in for
  // a real value -- so it reads as broken, because it would be.
  if (!shortSha) {
    return {
      shortSha: null,
      fullSha: null,
      environment,
      label: `${titleCase(environment)} · unknown build`,
      commitUrl: null,
    };
  }

  return {
    shortSha,
    fullSha,
    environment,
    label: `${titleCase(environment)} · ${shortSha}`,
    commitUrl,
  };
}

export function getBuildInfo(): BuildInfo {
  return buildInfoFrom(process.env);
}
