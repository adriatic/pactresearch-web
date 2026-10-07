import { LoginForm } from "./LoginForm";
import {
  parseSignInProblem,
  SIGN_IN_PROBLEM_MESSAGES,
} from "@/lib/signInProblems";

// Task 76. /auth/callback sends a failed sign-in here as ?error=<problem>
// (see lib/signInProblems.ts); anything unrecognised shows no message
// rather than echoing the query string.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const problem = parseSignInProblem((await searchParams).error);
  return (
    <LoginForm problem={problem ? SIGN_IN_PROBLEM_MESSAGES[problem] : null} />
  );
}
