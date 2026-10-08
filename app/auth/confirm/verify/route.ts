import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import { problemFromExchangeError } from "@/lib/signInProblems";

// Task 76 follow-up C1. The Sign in button on /auth/confirm posts here; this
// is the only place a new-form link is spent (verifyOtp with the
// token_hash). No PKCE verifier is involved, so it works in any browser.
//
// Only a form on this site may post here: otherwise another website could
// post its own token and sign the visitor into a different account. A
// failure goes to /login?error=<problem>, the same plain messages as the
// callback (an expired or already-used link is otp_expired).
//
// 303 so the browser follows with a GET.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const form = await request.formData();
  const tokenHash = form.get("token_hash");
  const type = form.get("type") === "magiclink" ? "magiclink" : "email";
  if (typeof tokenHash !== "string" || !tokenHash) {
    return redirectTo(url, "/login?error=link_failed");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type,
  });
  if (error) {
    const problem = problemFromExchangeError(error);
    console.error(
      `[auth-confirm] sign-in failed: ${problem} (${error.code ?? "no code"})`,
    );
    return redirectTo(url, `/login?error=${problem}`);
  }
  return redirectTo(url, "/");
}

function redirectTo(url: URL, path: string) {
  return NextResponse.redirect(new URL(path, url.origin), 303);
}
