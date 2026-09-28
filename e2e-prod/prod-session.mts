/**
 * prod-session.mts
 *
 * Shared helper for authenticating against PRODUCTION
 * (pact-web.pactresearch.net) as the dedicated, disposable test account
 * (nikolaj.ivancic+cctest@gmail.com), for investigation scripts and E2E
 * specs that need to exercise the real deployed app rather than local dev.
 *
 * This reads cc-test-session.json (gitignored, produced by
 * `node scripts/mint-test-session.mjs`) -- never the service-role key, which
 * this file never touches and never needs. The session it holds has
 * standard, non-elevated permissions, the same as any real PACT user,
 * scoped by RLS.
 *
 * Two ways to use it:
 *   - `prodFetch(path, init)` for authenticated fetch() calls against
 *     production API routes directly.
 *   - `getProdAuthCookies()` to get the raw cookie set, e.g. for a
 *     Playwright BrowserContext (see fixtures.ts in this directory).
 *
 * If the stored refresh token has itself expired or been revoked, both of
 * these throw TestSessionExpiredError -- at that point there is no
 * workaround short of asking Nik to run the minting script again.
 */

import { createServerClient } from "@supabase/ssr";
import { readFileSync, existsSync } from "fs";
import path from "path";

/** Production, and the default when nothing overrides it. */
export const PRODUCTION_BASE_URL = "https://pact-web.pactresearch.net";

/**
 * The deployment under test. Override to run the same specs against a
 * Preview URL:
 *
 *   PACT_E2E_BASE_URL=https://pactresearch-xxxx.vercel.app npm run test:e2e:prod
 */
export const E2E_TARGET_BASE_URL =
  process.env.PACT_E2E_BASE_URL || PRODUCTION_BASE_URL;

const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

/**
 * Headers that skip Deployment Protection, per Vercel's documented
 * contract. Empty when no secret is configured, so production -- which
 * is not protected -- keeps working with no setup at all.
 *
 * x-vercel-set-bypass-cookie is sent alongside the secret because a
 * browser navigation makes follow-up requests for assets; without the
 * cookie only the first request would carry the bypass. ("true" here;
 * "samesitenone" would be needed inside an iframe, which nothing does.)
 */
export function vercelBypassHeaders(): Record<string, string> {
  if (!BYPASS_SECRET) return {};
  return {
    "x-vercel-protection-bypass": BYPASS_SECRET,
    "x-vercel-set-bypass-cookie": "true",
  };
}

/**
 * The bypass WITHOUT the cookie header -- for plain fetch(), not a
 * browser.
 *
 * x-vercel-set-bypass-cookie makes Vercel answer with a redirect plus
 * Set-Cookie. A browser stores that cookie and the follow-up asset
 * requests sail through; Node's fetch does not persist it, so it
 * follows the redirect, gets redirected again, and dies with "redirect
 * count exceeded". Found by running this against a real protected
 * preview, not by reading the docs.
 *
 * A direct fetch needs no cookie anyway: every call carries the header
 * itself.
 */
export function vercelBypassRequestHeaders(): Record<string, string> {
  if (!BYPASS_SECRET) return {};
  return { "x-vercel-protection-bypass": BYPASS_SECRET };
}

/**
 * Fails fast on the one combination that produces a baffling failure:
 * aiming at a protected deployment with no secret. Without this the
 * specs run against Vercel's SSO login page and report missing
 * selectors, which reads as an application bug rather than a missing
 * environment variable.
 *
 * Production is exempt: it is public, so the secret is optional there
 * and the suite keeps working for anyone who has not set one up.
 */
export function assertTargetReachable(): void {
  if (E2E_TARGET_BASE_URL === PRODUCTION_BASE_URL) return;
  if (BYPASS_SECRET) return;
  throw new Error(
    `PACT_E2E_BASE_URL is set to ${E2E_TARGET_BASE_URL}, which is not production, ` +
      "but VERCEL_AUTOMATION_BYPASS_SECRET is not set. Vercel Deployment " +
      "Protection will serve its SSO page instead of the app. Generate a " +
      "secret under Vercel → project Settings → Deployment Protection → " +
      "Protection Bypass for Automation, and export it as " +
      "VERCEL_AUTOMATION_BYPASS_SECRET.",
  );
}

// Kept as the historical name used by existing specs and fixtures; it
// now follows the target above rather than being a second hard-coded
// copy of the production URL.
export const PROD_BASE_URL = E2E_TARGET_BASE_URL;

const SESSION_FILE = path.resolve(process.cwd(), "cc-test-session.json");

// How long before actual expiry we proactively refresh, so a token that's
// merely *close* to expiring (not yet expired) still gets renewed instead
// of being used right up to the wire.
const EXPIRY_BUFFER_SECONDS = 60;

interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id: string;
  email: string;
}

export class TestSessionExpiredError extends Error {
  constructor(message: string) {
    super(
      `${message} Run \`node scripts/mint-test-session.mjs\` again to produce a fresh cc-test-session.json.`,
    );
    this.name = "TestSessionExpiredError";
  }
}

function loadEnvFile(filename: string): Record<string, string> {
  const filePath = path.resolve(process.cwd(), filename);
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

function getProdSupabaseConfig(): { url: string; anonKey: string } {
  // Same source of truth as scripts/mint-test-session.mjs -- deliberately
  // not NEXT_PUBLIC_SUPABASE_URL/_ANON_KEY, which point at local dev
  // Supabase in this repo's .env.local.
  const env = {
    ...loadEnvFile(".env.local"),
    ...loadEnvFile(".env.test.local"),
    ...process.env,
  };
  const url = env.PROD_SUPABASE_URL;
  const anonKey = env.PROD_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing PROD_SUPABASE_URL / PROD_SUPABASE_ANON_KEY -- add them to .env.test.local (see scripts/mint-test-session.mjs).",
    );
  }
  return { url, anonKey };
}

function readStoredSession(): StoredSession {
  if (!existsSync(SESSION_FILE)) {
    throw new TestSessionExpiredError("No cc-test-session.json found.");
  }
  return JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as StoredSession;
}

/**
 * Returns a valid (non-expired) {access_token, refresh_token} pair,
 * transparently refreshing via the stored refresh_token if the access
 * token has expired or is within EXPIRY_BUFFER_SECONDS of expiring.
 */
async function getValidTokens(): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const stored = readStoredSession();
  const { url, anonKey } = getProdSupabaseConfig();

  const now = Date.now() / 1000;
  if (stored.expires_at - EXPIRY_BUFFER_SECONDS > now) {
    return {
      accessToken: stored.access_token,
      refreshToken: stored.refresh_token,
    };
  }

  const anonClient = createServerClient(url, anonKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  });

  const { data, error } = await anonClient.auth.refreshSession({
    refresh_token: stored.refresh_token,
  });

  if (error || !data.session) {
    throw new TestSessionExpiredError(
      `Stored session is expired and the refresh token could not renew it (${error?.message ?? "no session returned"}).`,
    );
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
}

/**
 * Returns the auth cookies the real magic-link login flow would set,
 * refreshing the session first if needed. Matches the exact cookie
 * name/shape @supabase/ssr's createServerClient produces (see
 * utils/supabase/server.ts and e2e/notebook-delete-lock.spec.ts, which use
 * the same capture-via-setAll pattern against local Supabase).
 */
export async function getProdAuthCookies(): Promise<
  { name: string; value: string }[]
> {
  const { url, anonKey } = getProdSupabaseConfig();
  const { accessToken, refreshToken } = await getValidTokens();

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            capturedCookies.push({ name, value });
          }
        });
      },
    },
  });

  const { error } = await jarClient.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    throw new TestSessionExpiredError(
      `Could not establish a session from the stored tokens (${error.message}).`,
    );
  }

  return capturedCookies;
}

/**
 * Authenticated fetch() against a production route. `pathOrUrl` may be a
 * path (resolved against PROD_BASE_URL) or a full URL.
 */
export async function prodFetch(
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : new URL(pathOrUrl, PROD_BASE_URL).toString();

  const cookies = await getProdAuthCookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const headers = new Headers(init.headers);
  headers.set("Cookie", cookieHeader);
  // Same bypass the browser contexts use. prodFetch talks to the
  // deployment directly rather than through Playwright, so it gets no
  // headers from the config -- without this, a spec calling prodFetch
  // against a protected Preview receives Vercel's SSO HTML and fails
  // on a JSON parse, which points nowhere near the real cause.
  for (const [name, value] of Object.entries(vercelBypassRequestHeaders())) {
    headers.set(name, value);
  }

  return fetch(url, { ...init, headers });
}
