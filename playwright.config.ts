import { defineConfig, devices } from "@playwright/test";

// Runs against a real PRODUCTION BUILD + real local Supabase (Docker) —
// the same local-only instance every integration test already uses, per
// .env.local.
//
// Production build, not `next dev`, and that is the point (task 48).
// Against the dev server, Fast Refresh remounts the React tree part-way
// through a test whenever the dev server finishes compiling something.
// Captured with timestamps from an instrumented run:
//
//   t=91980  the composer's onChange schedules the 2s autosave
//   t=93469  the dev server pushes an HMR "sync" over its websocket
//   t=93499  the tree remounts 30ms later, the switch effect's cleanup
//            runs, and the pending autosave is cancelled
//   ...      the debounce never fires and the draft is never written
//
// That sank three draft-lifecycle specs plus explorer-resize, sometimes
// deterministically and sometimes not, depending purely on whether a
// compile happened to land inside a timing window. None of it exists in
// a production build: no HMR socket, no Fast Refresh, nothing recompiles
// mid-run. All four pass against this config.
//
// The cost is a build per run (~20s). That is worth paying for a suite
// whose result means something — and it is also closer to what the app
// actually ships, which is the environment these specs should be
// asserting against anyway.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build then serve. Building here rather than relying on a stale
    // .next means a run can never silently test a previous commit's
    // bundle -- the failure mode that would make this change worse than
    // the dev server it replaces.
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    // Never reuse: a dev server left running from `npm run dev` would
    // otherwise be picked up and quietly reintroduce Fast Refresh.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
