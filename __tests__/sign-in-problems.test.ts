import { describe, expect, test } from "vitest";
import {
  parseSignInProblem,
  problemFromCallbackParams,
  problemFromExchangeError,
  sendLinkErrorMessage,
  SIGN_IN_PROBLEM_MESSAGES,
} from "@/lib/signInProblems";

// Task 76. The codes below are the ones Supabase actually returned when
// each case was reproduced against the local stack in WebKit.

describe("problemFromCallbackParams", () => {
  test("a used or expired link (verify redirected with otp_expired)", () => {
    const params = new URLSearchParams(
      "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(problemFromCallbackParams(params)).toBe("link_expired");
  });

  test("any other verify error", () => {
    expect(
      problemFromCallbackParams(
        new URLSearchParams("error=server_error&error_code=unexpected_failure"),
      ),
    ).toBe("link_failed");
  });

  test("no code and no error is not a usable link", () => {
    expect(problemFromCallbackParams(new URLSearchParams(""))).toBe(
      "link_failed",
    );
  });

  test("a code with no error goes on to the exchange", () => {
    expect(
      problemFromCallbackParams(new URLSearchParams("code=abc")),
    ).toBeNull();
  });
});

describe("problemFromExchangeError", () => {
  test("no PKCE verifier in this browser means a different browser", () => {
    expect(
      problemFromExchangeError({ code: "pkce_code_verifier_not_found" }),
    ).toBe("other_browser");
  });

  test.each(["flow_state_not_found", "flow_state_expired", "otp_expired"])(
    "%s reads as expired or already used",
    (code) => {
      expect(problemFromExchangeError({ code })).toBe("link_expired");
    },
  );

  test("anything else is a generic failure", () => {
    expect(problemFromExchangeError({})).toBe("link_failed");
  });
});

describe("parseSignInProblem", () => {
  test("accepts only known problems", () => {
    expect(parseSignInProblem("other_browser")).toBe("other_browser");
    expect(parseSignInProblem("<script>")).toBeNull();
    expect(parseSignInProblem(["link_expired"])).toBeNull();
    expect(parseSignInProblem(undefined)).toBeNull();
  });
});

describe("messages", () => {
  test("never contain a raw error code", () => {
    const all = [
      ...Object.values(SIGN_IN_PROBLEM_MESSAGES),
      sendLinkErrorMessage({ status: 429 }),
      sendLinkErrorMessage({}),
    ];
    for (const message of all) {
      expect(message).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });

  test("a rate-limited request says so", () => {
    expect(
      sendLinkErrorMessage({ code: "over_email_send_rate_limit" }),
    ).toMatch(/Too many sign-in emails/);
    expect(sendLinkErrorMessage({ status: 429 })).toMatch(
      /Too many sign-in emails/,
    );
  });
});
