import type { NextConfig } from "next";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";
import {
  findEnvProblems,
  formatEnvProblems,
  REQUIRED_ENV_VARS,
} from "./lib/requiredEnv";

// Task 75 round 2b. Turbopack's filesystem build cache (on by default
// since Next 16.3) is restored by Vercel from the previous deployment, and
// on Vercel it intermittently served a compiled globals.css from several
// builds earlier. Measured on a scratch branch: with the cache on, 1 of 3
// CSS-only pushes shipped the exact old chunk (3jxy_hb8vq8sy.css); with
// it off, 8 of 8 shipped the right CSS, for ~10s more per build. Never
// reproduced locally. Leave off until a Next upgrade is shown to fix it.
const nextConfig: NextConfig = {
  experimental: {
    turbopackFileSystemCacheForBuild: false,
  },
};

// Next loads and re-evaluates this config several times per build, so a
// module-level flag does not dedupe the success line (and a `let` at
// module scope does not survive Next's config compilation at all --
// measured: "ReferenceError: announced is not defined"). A key on
// globalThis does survive, because it is the same process.
const ANNOUNCED = Symbol.for("pact.envCheckAnnounced");
type AnnounceHolder = { [ANNOUNCED]?: boolean };

// Task 66. The environment check lives here, in the config function,
// rather than in a separate script, for one reason: this file is loaded
// and executed by `next build` itself, which is the command Vercel
// runs. There is nothing to wire up in a dashboard, nothing that can be
// skipped by invoking the build a different way, and no dependency on a
// standalone script's Node being new enough to import a .ts module.
//
// Next loads .env/.env.local before it loads this config, so the values
// seen here are exactly the ones the app will see -- verified, not
// assumed: a local `next build` with the variables only in .env.local
// passes, and the same build with one of them blanked fails naming it.
//
// WHICH PHASES, and the one surprise in it:
//
//   PHASE_PRODUCTION_BUILD   -- a failing deploy never goes live. This
//                               is the gate the 2026-09-27 outage
//                               needed and did not have.
//   PHASE_DEVELOPMENT_SERVER -- `next dev` says so at once, rather than
//                               on whichever request first touches the
//                               missing value.
//
// `next typegen` -- which `npm run typecheck` runs first -- also
// reports PHASE_PRODUCTION_BUILD. Measured; there is no phase or env
// flag that separates them, only argv. So typecheck needs these three
// variables too, and CI sets them to throwaway values rather than this
// file sniffing process.argv to guess which command invoked it. That is
// the better trade: it means the gate genuinely runs in CI, which is
// exactly what "a check that only runs locally would not have caught
// the Vercel deletion" is asking for.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_DEVELOPMENT_SERVER) {
    const problems = findEnvProblems(process.env);
    if (problems.length > 0) {
      // console.error first, then throw: Next wraps a config error in
      // its own framing, and the point of this task is that the exact
      // variable name is impossible to miss in the log.
      console.error("\n" + formatEnvProblems(problems) + "\n");
      throw new Error(
        `Environment check failed: ${problems
          .map((p) => `${p.name} (${p.detail})`)
          .join(", ")}`,
      );
    }
    // Said out loud on success too. A silent gate is one nobody can
    // tell apart from a gate that has been removed.
    const holder = globalThis as AnnounceHolder;
    if (!holder[ANNOUNCED]) {
      holder[ANNOUNCED] = true;
      console.log(
        `Environment check passed: ${REQUIRED_ENV_VARS.length} required variables present.`,
      );
    }
  }
  return nextConfig;
}
