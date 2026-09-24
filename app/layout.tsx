// Root layout: fonts + page metadata, shared by every route.
// (Geist fonts loaded via next/font/google for automatic self-hosting.)
import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css"; // Tailwind base + global resets.

// TEMPORARY DIAGNOSTIC (task 36 follow-up, composer-unusable-on-zero-cell-
// discussion investigation) -- captures every console.error/warn from the
// EARLIEST possible moment (beforeInteractive, ahead of React hydration
// itself), specifically to catch a hydration-mismatch warning that a
// later, normal-timed console listener would miss entirely. Nik's own
// diagnostic capture showed the same font/CSS resources re-fetched (cache
// hit, ~4ms) about 1.6s after loadEventEnd -- consistent with a full
// client-side remount, which is exactly what React does after detecting
// a hydration mismatch it can't reconcile. This confirms or rules that
// out with real evidence instead of continuing to guess. Remove once the
// mechanism is confirmed.
const DIAG_CONSOLE_CAPTURE = `
  window.__pactDiag = window.__pactDiag || { consoleLog: [], composerMounts: [] };
  var origError = console.error;
  var origWarn = console.warn;
  console.error = function() {
    try {
      window.__pactDiag.consoleLog.push({
        t: Math.round(performance.now()),
        level: "error",
        args: Array.prototype.slice.call(arguments).map(function(a) {
          try { return String(a); } catch (e) { return "(unstringifiable)"; }
        }),
      });
    } catch (e) {}
    return origError.apply(console, arguments);
  };
  console.warn = function() {
    try {
      window.__pactDiag.consoleLog.push({
        t: Math.round(performance.now()),
        level: "warn",
        args: Array.prototype.slice.call(arguments).map(function(a) {
          try { return String(a); } catch (e) { return "(unstringifiable)"; }
        }),
      });
    } catch (e) {}
    return origWarn.apply(console, arguments);
  };
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pact Research",
  description: "AI-assisted research notebooks powered by Claude.",
};

// The single root layout shared by every route in the app.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Script
          id="diag-console-capture"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: DIAG_CONSOLE_CAPTURE }}
        />
      </body>
    </html>
  );
}
