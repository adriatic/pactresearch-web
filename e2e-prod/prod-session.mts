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

export const PROD_BASE_URL = "https://pact-web.pactresearch.net";

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
    throw new TestSessionExpiredError(
      "No cc-test-session.json found.",
    );
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
    return { accessToken: stored.access_token, refreshToken: stored.refresh_token };
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

  return fetch(url, { ...init, headers });
}
