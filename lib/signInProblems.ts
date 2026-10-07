// Task 76. Why a magic-link sign-in failed, in words a user can act on.
//
// Before this, /auth/callback ignored every failure and redirected to /,
// which bounced a signed-out user to the email form with no explanation
// -- the same screen whatever went wrong. Supabase does say what went
// wrong, through stable error codes, so the callback classifies the
// failure into one of these and the login page shows the matching
// message. Raw codes never reach the screen.

export type SignInProblem = "link_expired" | "other_browser" | "link_failed";

export const SIGN_IN_PROBLEM_MESSAGES: Record<SignInProblem, string> = {
  link_expired:
    "This sign-in link has expired or was already used. Each link works " +
    "once, so open it directly rather than previewing it. Request a new " +
    "one below.",
  other_browser:
    "This sign-in link was opened in a different browser from the one " +
    "that requested it. Open the link in the same browser you requested " +
    "it from, or request a new one here.",
  link_failed: "That sign-in link didn't work. Request a new one below.",
};

export function parseSignInProblem(
  value: string | string[] | undefined,
): SignInProblem | null {
  return typeof value === "string" && value in SIGN_IN_PROBLEM_MESSAGES
    ? (value as SignInProblem)
    : null;
}

// Supabase's verify endpoint reports a rejected link by redirecting to the
// callback with ?error=…&error_code=… instead of ?code=…. A used link and
// an expired one share the code otp_expired ("Email link is invalid or has
// expired"), so they share a message.
export function problemFromCallbackParams(
  params: URLSearchParams,
): SignInProblem | null {
  const errorCode = params.get("error_code");
  if (errorCode === "otp_expired") return "link_expired";
  if (errorCode || params.get("error")) return "link_failed";
  if (!params.get("code")) return "link_failed";
  return null;
}

// exchangeCodeForSession's error once verify itself succeeded.
// pkce_code_verifier_not_found: this browser never requested the link,
// so it holds no PKCE verifier cookie. flow_state_*: the code was already
// exchanged (a refresh of the callback) or sat too long.
export function problemFromExchangeError(error: {
  code?: string;
}): SignInProblem {
  switch (error.code) {
    case "pkce_code_verifier_not_found":
      return "other_browser";
    case "flow_state_not_found":
    case "flow_state_expired":
    case "otp_expired":
      return "link_expired";
    default:
      return "link_failed";
  }
}

// signInWithOtp's error, shown on the request form. Before this the form
// said "Check your email" even when no email was sent.
export function sendLinkErrorMessage(error: {
  code?: string;
  status?: number;
}): string {
  if (
    error.status === 429 ||
    error.code === "over_email_send_rate_limit" ||
    error.code === "over_request_rate_limit"
  ) {
    return (
      "Too many sign-in emails were requested. Wait a minute, then try " +
      "again. If an earlier email arrives, its link may still work."
    );
  }
  return "We couldn't send a sign-in email just now. Please try again.";
}
