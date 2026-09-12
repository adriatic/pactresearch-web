/**
 * mint-test-session.mjs
 *
 * Run this yourself, locally, whenever CC needs a fresh production session
 * for the dedicated test account. This script uses the Supabase service-role
 * key -- which must NEVER be given to CC or committed anywhere -- to mint a
 * real, valid session for the test user WITHOUT sending or clicking a real
 * magic-link email.
 *
 * It writes only the resulting session (access_token, refresh_token,
 * expires_at) to a local JSON file. That file -- not the service-role key --
 * is the only thing CC ever reads.
 *
 * SETUP (one-time):
 *   1. In the Supabase dashboard for the production project (lznjqrfjgdrmxgzmkfje),
 *      go to Settings -> API and copy the "service_role" key (NOT the anon key)
 *      and the "anon" "public" key, and the project URL.
 *   2. Add the service-role key to .env.local (already gitignored):
 *        SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
 *      NOTE: .env.local's existing NEXT_PUBLIC_SUPABASE_URL and
 *      NEXT_PUBLIC_SUPABASE_ANON_KEY point at LOCAL DEV Supabase
 *      (127.0.0.1:54321), not production -- this script does NOT reuse
 *      those. Production values go in .env.test.local instead (see below).
 *   3. Add these lines to .env.test.local (already gitignored):
 *        TEST_USER_EMAIL=nikolaj.ivancic+cctest@gmail.com
 *        PROD_SUPABASE_URL=https://lznjqrfjgdrmxgzmkfje.supabase.co
 *        PROD_SUPABASE_ANON_KEY=<the production anon/public key>
 *
 * USAGE:
 *   node scripts/mint-test-session.mjs
 *
 * Run this again any time CC reports the session has expired or stopped
 * working -- it takes a few seconds and requires no email click.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadEnvFile(filename) {
  const filePath = path.join(repoRoot, filename);
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const localEnv = loadEnvFile(".env.local");
const testEnv = loadEnvFile(".env.test.local");
const env = { ...localEnv, ...testEnv, ...process.env };

// Deliberately NOT falling back to NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY --
// those point at local dev Supabase in this repo's .env.local, and silently
// using them here would mint a session against the wrong project.
const SUPABASE_URL = env.PROD_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.PROD_SUPABASE_ANON_KEY;
const TEST_USER_EMAIL = env.TEST_USER_EMAIL;

const missing = [];
if (!SUPABASE_URL) missing.push("PROD_SUPABASE_URL (add to .env.test.local)");
if (!SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY (add to .env.local)");
if (!ANON_KEY) missing.push("PROD_SUPABASE_ANON_KEY (add to .env.test.local)");
if (!TEST_USER_EMAIL) missing.push("TEST_USER_EMAIL (add to .env.test.local)");

if (missing.length > 0) {
  console.error("Missing required configuration:\n  " + missing.join("\n  "));
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log(`Minting a session for ${TEST_USER_EMAIL} ...`);

  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email: TEST_USER_EMAIL,
  });

  if (linkError) {
    console.error("Failed to generate link:", linkError.message);
    process.exit(1);
  }

  const hashedToken = linkData?.properties?.hashed_token;
  if (!hashedToken) {
    console.error("generateLink succeeded but no hashed_token was returned. Response shape may have changed.");
    process.exit(1);
  }

  const { data: verifyData, error: verifyError } = await anonClient.auth.verifyOtp({
    type: "email",
    token_hash: hashedToken,
  });

  if (verifyError) {
    console.error("Failed to verify token:", verifyError.message);
    process.exit(1);
  }

  const session = verifyData?.session;
  if (!session) {
    console.error("Verification succeeded but no session was returned.");
    process.exit(1);
  }

  const outputPath = path.join(repoRoot, "cc-test-session.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user_id: session.user.id,
        email: session.user.email,
      },
      null,
      2
    )
  );

  console.log(`Session written to ${outputPath}`);
  console.log(`Expires at: ${new Date(session.expires_at * 1000).toISOString()}`);
  console.log("This file is gitignored -- confirm with `git status` that it does not appear as trackable.");
}

main();
