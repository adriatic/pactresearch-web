import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginPage from "@/app/login/page";

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

describe("LoginPage", () => {
  beforeEach(() => {
    signInWithOtp.mockClear();
  });

  test("signs in with emailRedirectTo derived from the current origin, not a hardcoded URL", async () => {
    render(<LoginPage />);

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
});
