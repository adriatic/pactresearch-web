import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ANSWER_WAIT_MS,
  ASK,
  askForWaitingTab,
  HERE,
  waitForSignIn,
  type HandoffChannel,
} from "@/lib/signInHandoff";

// Task D17j. The tab hand-off with a fake BroadcastChannel: a bus that,
// like the real one, delivers a message to every other endpoint and not
// back to the sender, in a later task. Every message posted is kept, to
// check that nothing but the two fixed messages ever goes out.

type Listener = (event: { data: unknown }) => void;

function fakeBus() {
  const endpoints: { listeners: Set<Listener> }[] = [];
  const posted: unknown[] = [];
  const open = (): HandoffChannel => {
    const me = { listeners: new Set<Listener>() };
    endpoints.push(me);
    return {
      postMessage(message) {
        // Structured clone, as the real channel does.
        const data = JSON.parse(JSON.stringify(message));
        posted.push(data);
        for (const other of endpoints) {
          if (other === me) continue;
          for (const l of [...other.listeners]) {
            setTimeout(() => l({ data }), 0);
          }
        }
      },
      addEventListener: (_t, l) => void me.listeners.add(l),
      removeEventListener: (_t, l) => void me.listeners.delete(l),
    };
  };
  return { open, posted };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the tab hand-off", () => {
  test("a waiting tab that sees the session answers within the time and moves to the app", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    waitForSignIn({
      channel: bus.open(),
      hasSession: async () => true,
      onSignedIn,
    });
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(10);
    await expect(answered).resolves.toBe(true);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  test("no waiting tab: the link tab hears nothing and goes on after the wait", async () => {
    const bus = fakeBus();
    let result: boolean | undefined;
    void askForWaitingTab(bus.open()).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(ANSWER_WAIT_MS).toBe(1500);
  });

  test("an answer after the wait is too late: the link tab has already gone on", async () => {
    const bus = fakeBus();
    const slow = bus.open();
    // A waiting tab whose session check outlasts the wait.
    waitForSignIn({
      channel: slow,
      hasSession: () =>
        new Promise((r) => setTimeout(() => r(true), ANSWER_WAIT_MS + 500)),
      onSignedIn: () => {},
    });
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS + 1000);
    await expect(answered).resolves.toBe(false);
  });

  test("two waiting tabs: both move to the app, and the link tab counts it as answered", async () => {
    const bus = fakeBus();
    const first = vi.fn();
    const second = vi.fn();
    for (const onSignedIn of [first, second]) {
      waitForSignIn({
        channel: bus.open(),
        hasSession: async () => true,
        onSignedIn,
      });
    }
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(10);
    await expect(answered).resolves.toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("a waiting tab without a session neither answers nor moves", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    waitForSignIn({
      channel: bus.open(),
      hasSession: async () => false,
      onSignedIn,
    });
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await expect(answered).resolves.toBe(false);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(bus.posted).toEqual([ASK]);
  });

  test("a failing session check counts as no session", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    waitForSignIn({
      channel: bus.open(),
      hasSession: async () => {
        throw new Error("offline");
      },
      onSignedIn,
    });
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await expect(answered).resolves.toBe(false);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("only the two fixed messages go on the channel: no email, token or session", async () => {
    const bus = fakeBus();
    waitForSignIn({
      channel: bus.open(),
      hasSession: async () => true,
      onSignedIn: () => {},
    });
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(10);
    await answered;
    expect(bus.posted).toEqual([ASK, HERE]);
    for (const message of bus.posted) {
      expect(Object.keys(message as object)).toEqual(["type"]);
      expect(JSON.stringify(message)).not.toMatch(
        /@|token|session|ey[A-Za-z0-9]/i,
      );
    }
  });

  test("the fallback check (storage event, tab shown again) moves without answering, and only once", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    const waiting = waitForSignIn({
      channel: bus.open(),
      hasSession: async () => true,
      onSignedIn,
    });
    await waiting.check();
    await waiting.check();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(bus.posted).toEqual([]);
    // After moving it no longer answers an ask.
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await expect(answered).resolves.toBe(false);
  });

  test("a stopped waiting tab (it left the page) does not answer", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    const waiting = waitForSignIn({
      channel: bus.open(),
      hasSession: async () => true,
      onSignedIn,
    });
    waiting.stop();
    const answered = askForWaitingTab(bus.open());
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    await expect(answered).resolves.toBe(false);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("messages that are not the ask are ignored by a waiting tab", async () => {
    const bus = fakeBus();
    const onSignedIn = vi.fn();
    waitForSignIn({
      channel: bus.open(),
      hasSession: async () => true,
      onSignedIn,
    });
    const other = bus.open();
    other.postMessage({ type: "something-else" });
    other.postMessage("pact-sign-in:ask");
    other.postMessage(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
