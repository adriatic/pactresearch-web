// Root layout: fonts + page metadata, shared by every route.
// (Geist fonts loaded via next/font/google for automatic self-hosting.)
import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { DiagnosticCapture } from "./DiagnosticCapture";
import { CONSOLE_BUFFER_LIMIT, CONSOLE_ARG_MAX_CHARS } from "@/lib/diagnostics";
import "./globals.css"; // Tailwind base + global resets.

// Task 39: the always-on collection half of "Report a problem" (the UI
// half is app/DiagnosticCapture.tsx, the capture half lib/diagnostics.ts).
//
// Runs with strategy="beforeInteractive", i.e. ahead of React hydration,
// deliberately: a console listener attached any later cannot see
// hydration warnings, and "is React discarding and re-rendering the tree?"
// was a live hypothesis for days in task 36. A capture tool that can't
// answer that question is missing the case it most needs to answer.
//
// Two properties this script must hold, both learned from task 36:
//
//   - It can never break the page. Every path is wrapped, the original
//     console method is always called through to, and both buffers are
//     bounded (ring buffer of CONSOLE_BUFFER_LIMIT entries, each argument
//     truncated to CONSOLE_ARG_MAX_CHARS).
//
//   - Its pointer listener can never interfere with input. It is
//     registered `passive: true` on the BUBBLE phase, so the browser
//     itself forbids preventDefault, and it only reads coordinates.
//     Task 36 spent real time investigating whether a capture-phase
//     handler somewhere was swallowing clicks on the composer; this one
//     is structurally incapable of that.
const DIAGNOSTIC_COLLECTOR = `
(function () {
  try {
    var LIMIT = ${CONSOLE_BUFFER_LIMIT};
    var ARG_MAX = ${CONSOLE_ARG_MAX_CHARS};
    var buffer = [];
    window.__pactDiagConsole = buffer;

    ["log", "warn", "error"].forEach(function (level) {
      var original = console[level];
      if (typeof original !== "function") return;
      console[level] = function () {
        try {
          var args = Array.prototype.map.call(arguments, function (value) {
            var text;
            try {
              text = typeof value === "string" ? value : JSON.stringify(value);
            } catch (circular) {
              text = undefined;
            }
            if (typeof text !== "string") text = String(value);
            return text.length > ARG_MAX
              ? text.slice(0, ARG_MAX) + "...[truncated]"
              : text;
          });
          buffer.push({
            t: Math.round(performance.now()),
            level: level,
            args: args,
          });
          if (buffer.length > LIMIT) buffer.shift();
        } catch (ignored) {}
        return original.apply(console, arguments);
      };
    });

    var pointer = { x: null, y: null, t: null };
    window.__pactDiagPointer = pointer;
    document.addEventListener(
      "pointerdown",
      function (event) {
        try {
          // Ignore clicks on the diagnostic UI itself. Without this the
          // act of opening a capture would overwrite the very click the
          // user is trying to report ("I clicked here and nothing
          // happened"), leaving every hit-test pointing at the Report
          // button. Elements of that UI carry data-pact-diag.
          var target = event.target;
          if (target && typeof target.closest === "function" &&
              target.closest("[data-pact-diag]")) {
            return;
          }
          pointer.x = event.clientX;
          pointer.y = event.clientY;
          pointer.t = Math.round(performance.now());
        } catch (ignored) {}
      },
      { passive: true, capture: false }
    );
  } catch (ignored) {}
})();
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
        <Script
          id="pact-diagnostic-collector"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: DIAGNOSTIC_COLLECTOR }}
        />
        {children}
        <DiagnosticCapture />
      </body>
    </html>
  );
}
