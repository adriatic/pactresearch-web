import posthog from "posthog-js";

// Task 40: PostHog Session Replay, the passive counterpart to task 39's
// on-demand "Report a problem" capture. Task 36's bug was hard to
// reproduce, timing-sensitive and invisible to console logging; a replay
// of what actually happened is meant to make that class of bug
// investigable without the user having hit a capture button at the right
// moment.
//
// This file (root-level `instrumentation-client.ts`) is Next's own
// supported client-instrumentation entry point -- see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// instrumentation-client.md: "allows you to add monitoring, analytics
// code, and other side-effects that run before your application becomes
// interactive", placed in the root of the application. It requires Next
// 15.3+; this repo is on 16.3.4. That placement is also why this task
// touches neither app/layout.tsx nor any component -- it stays fully
// independent of task 39, which ships separately.

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

// Automated browsers are excluded from recording. This is not a
// theoretical precaution: the PostHog vars are present in .env.local, so
// the very first full E2E run after wiring this up initialised PostHog
// and recorded ~38 Playwright sessions into the real project. Every
// future `npm run test:e2e` would keep doing so, burying real sessions
// under automated noise and directly undermining the point of having
// replays. navigator.webdriver is set by Playwright (verified
// empirically, not assumed) and by automation drivers generally.
//
// Deliberately NOT a localhost check: genuine local development is worth
// recording if Nik wants it, and the env vars are configured locally on
// purpose. Only automation is excluded.
const isAutomatedBrowser =
  typeof navigator !== "undefined" && navigator.webdriver === true;

// Task 72 follow-up 2 (Nik, 2026-10-10): PostHog does not start at all on
// the sign-in pages. /auth/confirm carries the one-time sign-in token in
// its address and in a hidden field; a recording keeps both, and every
// event carries the address. /login is switched off with it. Not starting
// is the whole switch: there is no recording and no event to scrub.
//
// The other sign-in addresses (/auth/callback, /auth/confirm/verify,
// /logout) are server redirects that never show a page, so PostHog never
// runs there anyway. Checked once, at page start, which is enough: nothing
// in the app moves to these pages client-side (they are reached by server
// redirects, an email link and a plain <a href="/login">).
const isSignInPage =
  typeof location !== "undefined" &&
  /^\/(login|auth)(\/|$)/.test(location.pathname);

// Init only when a token is actually configured, so a missing var is a
// silent no-op rather than posthog.init being called with `undefined`.
if (token && !isAutomatedBrowser && !isSignInPage) {
  posthog.init(token, {
    api_host: apiHost,

    // The dated-defaults bundle PostHog's own Next.js guide specifies.
    // Verified against this SDK's shipped ConfigDefaults union
    // (posthog-js 1.434.13) rather than assumed. Checked what it
    // actually changes: history-based pageviews, persistence debounce,
    // split storage, rageclick tuning -- it does NOT alter any masking
    // behaviour, so it cannot quietly re-enable redaction.
    defaults: "2026-05-30",

    session_recording: {
      // THE masking decision (Nik, 2026-09-24): replays must show
      // prompt/response text exactly as it appears on screen, because
      // seeing the actual research content is the entire point of having
      // them. Ships deliberately unmasked.
      //
      // maskAllInputs defaults to TRUE in the SDK, so this flag is the
      // one that actually matters -- without it every input, including
      // the composer, records as asterisks.
      maskAllInputs: false,

      // Non-input text (prompts rendered into the DOM, model responses,
      // discussion names) is NOT masked by default -- maskTextSelector
      // is unset out of the box. Set explicitly to null anyway so the
      // intent is stated in the config rather than resting on a default
      // that a future SDK version could change.
      maskTextSelector: null,
    },

    // Deliberately NOT configured here: maskInputOptions. With
    // maskAllInputs false, the SDK still adds `password: true` to any
    // partial override, so password fields stay masked unless explicitly
    // unmasked. That default is kept. It is a no-op for this app today
    // (sign-in is a magic link -- the only auth input is an email
    // address, and there is no password field anywhere), so keeping it
    // costs nothing and avoids ever recording a credential if one is
    // added later.
  });
}
