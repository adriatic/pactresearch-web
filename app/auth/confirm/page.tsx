import type { Metadata } from "next";

// Task 76 follow-up C1. Where a sign-in link from the email lands. Loading
// this page spends nothing: only the Sign in button (a POST to
// /auth/confirm/verify) redeems the link. So a link preview, a mail scanner
// or Mail opening the link in another browser cannot use it up, and the
// link works in any browser -- a token_hash needs nothing stored in the
// browser that asked for it.
// Task 72 follow-up 2. The Sign in button lands on / with this page as its
// referrer, and PostHog on / records the referrer. "origin" sends only the
// site address, never ?token_hash=. Not "no-referrer": that would make the
// browser send `Origin: null` with the POST, and verify rejects that.
export const metadata: Metadata = { referrer: "origin" };

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const tokenHash =
    typeof params.token_hash === "string" ? params.token_hash : "";
  const type = params.type === "magiclink" ? "magiclink" : "email";

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
      {tokenHash ? (
        <form
          method="post"
          action="/auth/confirm/verify"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            width: "300px",
          }}
        >
          <p style={{ margin: 0, textAlign: "center" }}>
            Press the button to finish signing in.
          </p>
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
          <button
            type="submit"
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
            Sign in
          </button>
        </form>
      ) : (
        <p role="alert" style={{ width: "300px", textAlign: "center" }}>
          This sign-in link is incomplete.{" "}
          <a href="/login">Request a new one.</a>
        </p>
      )}
    </main>
  );
}
