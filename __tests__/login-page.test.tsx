import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LoginForm } from "@/app/login/LoginForm";

// Regression guard for a real bug: a hardcoded redirect URL would break
// either local testing (pointing at production) or production (pointing at
// localhost) depending on which was hardcoded. The redirect must always be
// derived from wherever the request actually originated.
const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth: { signInWithOtp },
  }),
}));

describe("LoginForm", () => {
  beforeEach(() => {
    signInWithOtp.mockClear();
  });
  afterEach(cleanup);

  test("signs in with emailRedirectTo derived from the current origin, not a hardcoded URL", async () => {
    render(<LoginForm problem={null} />);

    fireEvent.change(screen.getByPlaceholderText("your@email.com"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a link/i }));

    await waitFor(() => expect(signInWithOtp).toHaveBeenCalledTimes(1));

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "test@example.com",
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  });

  // Task 76: a failed callback's message is shown above the form.
  test("shows the message it was given", () => {
    render(<LoginForm problem="This sign-in link has expired." />);
    expect(screen.getByRole("alert").textContent).toBe(
      "This sign-in link has expired.",
    );
  });

  // Task 76: a failed request used to say "Check your email" anyway.
  test("a failed request shows an error instead of claiming an email was sent", async () => {
    signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: { status: 429, code: "over_email_send_rate_limit" },
    });
    render(<LoginForm problem={null} />);

    fireEvent.change(screen.getByPlaceholderText("your@email.com"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a link/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Too many sign-in emails/,
    );
    expect(screen.queryByText("Check your email")).toBeNull();
  });
});
