import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import {
  problemFromCallbackParams,
  problemFromExchangeError,
  type SignInProblem,
} from "@/lib/signInProblems";

// Task 76. This used to ignore every failure -- a rejected link and a
// failed code exchange both redirected to /, which bounced a signed-out
// user to the email form with no explanation. Failures now go to
// /login?error=<problem> so the form can say what happened.
//
// Logged by error code only: never the auth code itself, and never the
// user's email. Vercel's runtime logs are where a failure on a real device
// can be traced after the fact.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const rejected = problemFromCallbackParams(searchParams);
  if (rejected) {
    return failed(origin, rejected, searchParams.get("error_code"));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(
    searchParams.get("code")!,
  );
  if (error) {
    return failed(origin, problemFromExchangeError(error), error.code ?? null);
  }

  return NextResponse.redirect(`${origin}/`);
}

function failed(origin: string, problem: SignInProblem, code: string | null) {
  console.error(
    `[auth-callback] sign-in failed: ${problem} (${code ?? "no code"})`,
  );
  return NextResponse.redirect(`${origin}/login?error=${problem}`);
}
