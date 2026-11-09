"use client";

import { useEffect, useState } from "react";
import {
  askForWaitingTab,
  HANDOFF_CHANNEL,
  HANDOFF_STORAGE_KEY,
} from "@/lib/signInHandoff";

// Task D17j, the tab the link opened. A server redirect brings it here
// (from /auth/callback) or location.replace (from /auth/confirm's Sign in
// button), never a navigation that adds a history entry: Chrome lets a
// page close a tab it did not open only while that tab's history holds a
// single entry, which is the case for a tab Mail opened.
//
// If no tab answers, this tab opens the app with location.replace, so the
// app is reached exactly as before, one history entry and all.
export const SIGNED_IN_NOTE =
  "You are signed in. The app is open in your first tab. You can close this tab.";

export function SignedInHandoff() {
  const [handedOver, setHandedOver] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof BroadcastChannel === "undefined") {
      // The fallback: a storage event tells a waiting tab (which then
      // moves to the app), but nothing can answer, so this tab opens the
      // app too. Only here: with a channel, a waiting tab acting on the
      // storage event would move without answering the ask.
      try {
        localStorage.setItem(HANDOFF_STORAGE_KEY, String(Date.now()));
      } catch {
        // Storage may be blocked; the visibility check still works.
      }
      window.location.replace("/");
      return;
    }
    const channel = new BroadcastChannel(HANDOFF_CHANNEL);
    void askForWaitingTab(channel).then((answered) => {
      channel.close();
      if (cancelled) return;
      if (!answered) {
        window.location.replace("/");
        return;
      }
      setHandedOver(true);
      // Refused if the browser does not count this as a tab the page may
      // close; the note then stays and says what to do.
      window.close();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "sans-serif",
        padding: "0 16px",
        boxSizing: "border-box",
        textAlign: "center",
      }}
    >
      <h1>Sign in to PACT</h1>
      {handedOver ? (
        <p role="status" style={{ maxWidth: "300px", lineHeight: 1.4 }}>
          {SIGNED_IN_NOTE}
        </p>
      ) : (
        <p role="status">Signing in…</p>
      )}
    </main>
  );
}
