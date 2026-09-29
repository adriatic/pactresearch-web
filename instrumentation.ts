import { registerOTel } from "@vercel/otel";
import { findEnvProblems, formatEnvProblems } from "./lib/requiredEnv";

// "pactresearch-web" names this production deployment specifically,
// distinct from the clone's own service name ("pactresearch-web-
// instrumented") -- this instrumentation approach, the span hierarchy
// below, and the throttle interval were all built and measured on that
// clone first (see its own task history) and ported here once proven.
//
// Task 66 also makes this the SECOND of two environment checks. The
// first, in next.config.ts, fails the build so a broken deploy never
// goes live; that is the gate that matters. This one runs once when a
// server instance boots, and covers what a build-time check cannot see
// -- a `next start` against an environment the build never inspected.
//
// It LOGS rather than throwing, and that is a deliberate call worth
// stating. Throwing here would stop the instance serving at all, which
// turns "one feature is broken" into "the whole site is down" -- a
// bigger outage than the one this task exists to prevent. What was
// missing on 2026-09-27 was not enforcement at boot, it was anyone
// being told; a named variable in the startup log is that. Flipping
// this to a throw is one line if that turns out to be the wrong call.
export function register() {
  registerOTel({ serviceName: "pactresearch-web" });

  const problems = findEnvProblems(process.env);
  if (problems.length > 0) {
    console.error(
      "\n================ STARTUP ENVIRONMENT CHECK FAILED ================\n" +
        formatEnvProblems(problems) +
        "\n==================================================================\n",
    );
  }
}
