"use client";

import type { FormEvent, ReactNode } from "react";

// Task D17j. The Sign in form of /auth/confirm, same fields and words as
// before. With JavaScript it posts with fetch and moves on with
// location.replace, so the tab Mail opened still has one history entry
// when it reaches /auth/signed-in (Chrome lets a page close a tab only
// then). If fetch fails, or without JavaScript, the form posts as before.
export function ConfirmForm({
  style,
  children,
}: {
  style: React.CSSProperties;
  children: ReactNode;
}) {
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    if (typeof fetch !== "function") return;
    e.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { accept: "application/json" },
      });
      const { location } = (await response.json()) as { location?: unknown };
      if (typeof location === "string" && location.startsWith("/")) {
        window.location.replace(location);
        return;
      }
    } catch {
      // Fall through to the plain post.
    }
    form.submit();
  }

  return (
    <form
      method="post"
      action="/auth/confirm/verify"
      onSubmit={handleSubmit}
      style={style}
    >
      {children}
    </form>
  );
}
