import type { Metadata } from "next";
import { SignedInHandoff } from "./SignedInHandoff";

// Task D17j. Where a finished magic-link sign-in lands, instead of going
// straight to /: the Sign in button on /auth/confirm, and the old-form
// link through /auth/callback. SignedInHandoff asks whether the tab where
// the email was typed is still waiting; if so that tab becomes the app and
// this one closes, otherwise this tab opens the app as before.
//
// No token reaches this address, but the referrer policy matches
// /auth/confirm's (Task 72 follow-up 2) so / never records it either.
export const metadata: Metadata = { referrer: "origin" };

export default function SignedInPage() {
  return <SignedInHandoff />;
}
