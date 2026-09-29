// Task 66. One place that says which environment variables this app
// cannot run without, and a check that says so out loud before the app
// is serving traffic rather than after.
//
// WHY. On 2026-09-27 API_KEY_ENCRYPTION_SECRET was deleted from Vercel.
// The build succeeded, the deploy went live, and nothing said a word.
// The only symptom was a bare 500, and only on the one request path
// that touched the secret, so it stayed broken until someone happened
// to use that path. A missing secret should not be discoverable by
// waiting for a user to find it.
//
// Pure, and takes the environment as an argument, so the whole thing is
// unit-testable without mutating process.env.

export const ENCRYPTION_KEY_BYTES = 32;

// Present-but-wrong is the same outage as absent. `vercel env pull`
// writes an 11-character placeholder for Secret-type variables, so a
// value that is merely THERE proves nothing -- checking the shape is
// what makes this check worth running.
//
// Returns a reason, or null when the value is usable. Never returns the
// value itself, or any part of it: this string ends up in build logs.
export function encryptionSecretProblem(raw: string): string | null {
  // Buffer.from(..., "base64") does not throw on invalid input, it
  // silently skips what it cannot decode -- so the length check below
  // is what actually catches a malformed value, not a try/catch.
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== ENCRYPTION_KEY_BYTES) {
    return `must decode from base64 to ${ENCRYPTION_KEY_BYTES} bytes, got ${decoded.length}`;
  }
  return null;
}

function urlProblem(raw: string): string | null {
  try {
    new URL(raw);
    return null;
  } catch {
    return "is not a valid URL";
  }
}

export interface RequiredEnvVar {
  name: string;
  /** What stops working without it -- printed alongside the failure. */
  why: string;
  /** Shape check for values where present-but-wrong fails as opaquely as absent. */
  problem?: (raw: string) => string | null;
}

export const REQUIRED_ENV_VARS: RequiredEnvVar[] = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    why: "every Supabase client (browser, server, middleware) is constructed from it; without it nothing authenticates and no data loads",
    problem: urlProblem,
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    why: "the anon key those same clients authenticate with",
  },
  {
    name: "API_KEY_ENCRYPTION_SECRET",
    why: "AES-256-GCM key for stored third-party API keys; without it saving or using a personal Anthropic key fails with a 500 (the 2026-09-27 outage)",
    problem: encryptionSecretProblem,
  },
];

// Not enforced, and listed so the list above can be audited rather than
// guessed at. Anything here is genuinely optional: the app runs without
// it, with a named feature switched off.
export const OPTIONAL_ENV_VARS: { name: string; why: string }[] = [
  {
    name: "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
    why: "analytics; instrumentation-client skips PostHog entirely when absent",
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_HOST",
    why: "analytics host; PostHog's default is used when absent",
  },
  {
    name: "VERCEL_GIT_COMMIT_SHA / VERCEL_ENV / VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG",
    why: "Vercel system variables read by the build badge; absent on a developer's machine by design, where the badge says so",
  },
];

export interface EnvProblem {
  name: string;
  /** "missing" for absent or blank; otherwise what is wrong with the value. */
  detail: string;
  why: string;
}

export function findEnvProblems(
  env: Record<string, string | undefined>,
  required: RequiredEnvVar[] = REQUIRED_ENV_VARS,
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  for (const variable of required) {
    const raw = env[variable.name];
    // Whitespace counts as missing. A variable set to " " in a
    // dashboard is a variable someone meant to set and did not.
    if (raw === undefined || raw.trim() === "") {
      problems.push({
        name: variable.name,
        detail: "missing",
        why: variable.why,
      });
      continue;
    }
    const detail = variable.problem?.(raw);
    if (detail) {
      problems.push({ name: variable.name, detail, why: variable.why });
    }
  }
  return problems;
}

// The message the brief asked for: names the exact variable, not a
// stack trace from wherever it first happened to be read.
export function formatEnvProblems(problems: EnvProblem[]): string {
  const lines = problems.map((p) =>
    p.detail === "missing"
      ? `  Missing required environment variable: ${p.name}\n      needed for: ${p.why}`
      : `  Invalid required environment variable: ${p.name} ${p.detail}\n      needed for: ${p.why}`,
  );
  return [
    `Environment check failed: ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
    "",
    ...lines,
    "",
    "Set these in the deployment environment (Vercel project settings, or",
    ".env.local for local development -- see .env.local.example) and retry.",
  ].join("\n");
}
