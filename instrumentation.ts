import { registerOTel } from "@vercel/otel";

// "pactresearch-web" names this production deployment specifically,
// distinct from the clone's own service name ("pactresearch-web-
// instrumented") -- this instrumentation approach, the span hierarchy
// below, and the throttle interval were all built and measured on that
// clone first (see its own task history) and ported here once proven.
export function register() {
  registerOTel({ serviceName: "pactresearch-web" });
}
