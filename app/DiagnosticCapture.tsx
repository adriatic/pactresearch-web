"use client";

import { useEffect, useState } from "react";
import { captureDiagnostics, type DiagnosticCapture } from "@/lib/diagnostics";

// Task 39: the "Report a problem" trigger -- the permanent replacement for
// task 36's hand-written bookmarklets.
//
// Placement: rendered from the ROOT layout, not from Workspace, and
// positioned fixed. The entire point is capturing a broken UI, so it must
// not depend on the subtree it is inspecting: if Workspace's layout
// collapses (task 36's exact failure), this button is still there and
// still clickable. It is also then available on /login, which costs
// nothing.
//
// Deliberately NO global keyboard shortcut. A document-level keydown
// listener would run on every keystroke typed into the composer, and
// "a listener quietly interfering with composer input" is precisely the
// class of bug task 36 spent days on (its own code comments record a
// browser extension swallowing Enter). The Escape handler below is safe
// by contrast: it only exists while the modal is open, so it cannot be in
// the path of normal typing.
//
// No network call is made to produce or view a capture -- same property
// the bookmarklets had, so it keeps working when other things don't.

const BUTTON_LABEL = "Report a problem";

export function DiagnosticCapture() {
  const [capture, setCapture] = useState<DiagnosticCapture | null>(null);
  const [copied, setCopied] = useState(false);

  const json = capture ? JSON.stringify(capture, null, 2) : "";

  useEffect(() => {
    if (!capture) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setCapture(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [capture]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API needs a secure context and can be permission-gated;
      // the textarea below is always selectable as a manual fallback, so
      // a failure here is not worth an error dialog.
      setCopied(false);
    }
  }

  function handleDownload() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pact-diagnostic-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button
        type="button"
        // Read by layout.tsx's pointer tracker, which skips clicks inside
        // the diagnostic UI so opening a capture doesn't overwrite the
        // click the user is actually trying to report.
        data-pact-diag=""
        // Stops the button taking focus, so document.activeElement still
        // reflects whatever the USER had focused. Without this every
        // capture reports activeElement: BUTTON, which would make the
        // single most diagnostic field in task 36's decisive capture --
        // "activeElement is BODY", the signature of a broken-focus bug --
        // permanently unobservable by this tool.
        //
        // This is the one deliberate preventDefault in the feature, and
        // it is not in tension with the no-global-listener rule above: it
        // is scoped to this button's own mousedown, affects nothing but
        // whether this button focuses itself, and is the standard pattern
        // for a control that must not disturb the focus it is inspecting.
        // onClick still fires normally.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setCopied(false);
          setCapture(captureDiagnostics());
        }}
        title="Capture a client-side diagnostic snapshot of the current state"
        style={{
          position: "fixed",
          right: 12,
          bottom: 12,
          // Above the app's own chrome, but this is the only fixed
          // overlay in the app so there is nothing to compete with.
          zIndex: 2147483000,
          fontSize: "0.8em",
          padding: "4px 10px",
          opacity: 0.85,
        }}
      >
        {BUTTON_LABEL}
      </button>

      {capture && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Diagnostic capture"
          data-pact-diag=""
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483100,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCapture(null);
          }}
        >
          <div
            style={{
              background: "var(--background, #fff)",
              color: "var(--foreground, #171717)",
              border: "1px solid #888",
              borderRadius: 6,
              width: "min(900px, 100%)",
              maxHeight: "100%",
              display: "flex",
              flexDirection: "column",
              padding: 12,
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <strong>Diagnostic capture</strong>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={handleCopy}>
                  {copied ? "Copied ✓" : "Copy JSON"}
                </button>
                <button type="button" onClick={handleDownload}>
                  Download
                </button>
                <button type="button" onClick={() => setCapture(null)}>
                  Close
                </button>
              </span>
            </div>
            {/* A readonly textarea rather than <pre>: it stays
                select-all-able and manually copyable even if the
                Clipboard API is unavailable. */}
            <textarea
              readOnly
              aria-label="Diagnostic capture JSON"
              value={json}
              style={{
                flex: 1,
                minHeight: 320,
                fontFamily: "monospace",
                fontSize: "0.75em",
                whiteSpace: "pre",
                border: "1px solid #ccc",
                borderRadius: 4,
                padding: 8,
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
