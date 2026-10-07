"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { sendLinkErrorMessage } from "@/lib/signInProblems";

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
            border: "1px solid #c99",
            borderRadius: "6px",
            background: "#fdf0f0",
            color: "#7a1f1f",
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
            border: "1px solid #ccc",
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px",
            fontSize: "16px",
            borderRadius: "6px",
            background: "#000",
            color: "#fff",
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
