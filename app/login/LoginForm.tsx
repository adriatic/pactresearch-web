"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { sendLinkErrorMessage } from "@/lib/signInProblems";
import {
  HANDOFF_CHANNEL,
  HANDOFF_STORAGE_KEY,
  waitForSignIn,
} from "@/lib/signInHandoff";

// Task D17j: how long the waiting tab waits after answering before it
// moves to the app. Well inside the link tab's ANSWER_WAIT_MS.
const MOVE_DELAY_MS = 300;

// Task 76: the client half of /login. page.tsx (a server component) reads
// ?error= from a failed /auth/callback and passes the matching message in
// as `problem`, so a bounced sign-in explains itself instead of silently
// showing the empty form again.
export function LoginForm({ problem }: { problem: string | null }) {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  // Set when the request itself fails (e.g. rate limited). Cleared on the
  // next attempt. Replaces `problem` once the user has tried again.
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    setSendError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setLoading(false);
    // Task 76: this used to say "Check your email" whatever happened, so a
    // rate-limited or failed request looked exactly like a sent one.
    if (error) {
      setSendError(sendLinkErrorMessage(error));
      return;
    }
    setSubmitted(true);
  }

  // Task D17j. Once the link has been sent, this tab waits for the sign-in
  // to finish in another tab of the same browser (the one the link opens)
  // and then becomes the app itself. Three ways to learn it: the link
  // tab's ask on the channel, a storage event (where BroadcastChannel is
  // missing), and a session check whenever this tab is shown again.
  // location.replace, so Back does not return to the "Check your email"
  // page; the app is the same screen a fresh sign-in shows.
  useEffect(() => {
    if (!submitted) return;
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(HANDOFF_CHANNEL);
    const supabase = createClient();
    const waiting = waitForSignIn({
      channel,
      hasSession: async () =>
        (await supabase.auth.getSession()).data.session !== null,
      // A short pause first, as a precaution: the "here" answer travels
      // between tabs through the browser, and this page should not unload
      // before it has left. The tests pass with no pause too (Chromium and
      // WebKit, 0 ms, three times each), so this is not a proven need.
      onSignedIn: () =>
        setTimeout(() => window.location.replace("/"), MOVE_DELAY_MS),
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === HANDOFF_STORAGE_KEY) void waiting.check();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void waiting.check();
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      waiting.stop();
      channel?.close();
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [submitted]);

  // The request's own error wins over the callback's: it is the newer news.
  const message = sendError ?? problem;

  if (submitted) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "sans-serif",
        }}
      >
        <h1>Check your email</h1>
        <p>
          We sent a login link to <strong>{email}</strong>
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "sans-serif",
      }}
    >
      <h1>Sign in to PACT</h1>
      {message && (
        <p
          role="alert"
          style={{
            width: "300px",
            boxSizing: "border-box",
            margin: "0 0 12px",
            padding: "10px",
            border: "1px solid var(--notice-danger-border)",
            borderRadius: "6px",
            background: "var(--notice-danger-bg)",
            color: "var(--notice-danger-text)",
            fontSize: "15px",
            lineHeight: 1.4,
          }}
        >
          {message}
        </p>
      )}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "300px",
        }}
      >
        <input
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{
            padding: "10px",
            fontSize: "16px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px",
            fontSize: "16px",
            borderRadius: "6px",
            background: "var(--primary-bg)",
            color: "var(--primary-text)",
            border: "none",
            cursor: "pointer",
          }}
        >
          {loading ? "Sending..." : "Send me a link"}
        </button>
      </form>
    </main>
  );
}
