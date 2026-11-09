// Task D17j. After a magic-link click, the app opens in the tab where the
// email was typed, not only in the new tab the link opened.
//
// Two tabs of the same browser talk over a BroadcastChannel:
//
//   the waiting tab   /login after "Send me a link" (app/login/LoginForm.tsx)
//   the link tab      /auth/signed-in, where a finished sign-in lands
//                     (app/auth/signed-in/SignedInHandoff.tsx)
//
// The link tab asks "is a tab waiting?". A waiting tab that can see the
// session (cookies are shared by the tabs of one browser) answers "here"
// and moves to the app. If an answer comes within ANSWER_WAIT_MS the link
// tab says so and closes itself; otherwise it opens the app as before.
// So a link opened in another browser, another device, a private window,
// or after the first tab was closed, still shows the app.
//
// Only these two fixed messages ever go on the channel: never an email
// address, a token or anything about the session but the fact that a tab
// is asking or answering. A waiting tab moves only once it has checked
// that a session exists, so a stray "ask" from any other page of this site
// cannot take it anywhere.

export const HANDOFF_CHANNEL = "pact-sign-in";
/** localStorage key: the fallback signal where BroadcastChannel is missing. */
export const HANDOFF_STORAGE_KEY = "pact-sign-in";
export const ANSWER_WAIT_MS = 1500;

export const ASK = { type: "pact-sign-in:ask" } as const;
export const HERE = { type: "pact-sign-in:here" } as const;

/** The part of BroadcastChannel used here, so tests can pass a fake. */
export interface HandoffChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

const isType = (data: unknown, type: string) =>
  typeof data === "object" &&
  data !== null &&
  (data as { type?: unknown }).type === type;

/**
 * The link tab: asks whether a tab is waiting and resolves true as soon as
 * one answers, or false after `waitMs` with no answer.
 */
export function askForWaitingTab(
  channel: HandoffChannel,
  waitMs: number = ANSWER_WAIT_MS,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (answered: boolean) => {
      timers.clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      resolve(answered);
    };
    const onMessage = (event: { data: unknown }) => {
      if (isType(event.data, HERE.type)) done(true);
    };
    const timer = timers.setTimeout(() => done(false), waitMs);
    channel.addEventListener("message", onMessage);
    channel.postMessage(ASK);
  });
}

/**
 * The waiting tab: on an ask, checks that a session exists; if it does,
 * answers and calls `onSignedIn` (once). `check` alone runs the same test
 * without answering, for the fallbacks (a storage event, the tab becoming
 * visible again). Returns `stop`, which ends the listening.
 */
export function waitForSignIn(opts: {
  channel: HandoffChannel | null;
  hasSession: () => Promise<boolean>;
  onSignedIn: () => void;
}): { check: () => Promise<void>; stop: () => void } {
  let finished = false;
  const tryFinish = async (answer: boolean) => {
    if (finished) return;
    let signedIn = false;
    try {
      signedIn = await opts.hasSession();
    } catch {
      signedIn = false;
    }
    if (!signedIn || finished) return;
    finished = true;
    if (answer) opts.channel?.postMessage(HERE);
    stop();
    opts.onSignedIn();
  };
  const onMessage = (event: { data: unknown }) => {
    if (isType(event.data, ASK.type)) void tryFinish(true);
  };
  const stop = () => {
    opts.channel?.removeEventListener("message", onMessage);
  };
  opts.channel?.addEventListener("message", onMessage);
  return {
    check: () => tryFinish(false),
    stop: () => {
      finished = true;
      stop();
    },
  };
}
