"use client";

import { useEffect, useState } from "react";

// Task 51's key field, moved out of AccountDialog in Task 81 so the
// Anthropic and OpenAI keys use the same one: masked, Show and Hide, its
// own Save, and a status read from the server that never includes the
// key. Every behaviour below is Task 51's, unchanged.
export function ApiKeyField({
  route,
  label,
  placeholder,
  active,
  onStatus,
  onBusyChange,
}: {
  // e.g. "/api/account/anthropic-key"
  route: string;
  // The visible label, e.g. "Anthropic API key:"
  label: string;
  placeholder: string;
  // The Keys tab is showing: the status is (re-)read each time it opens.
  active: boolean;
  onStatus?: (hasKey: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyHintText, setKeyHintText] = useState<string | null>(null);
  const [keyBusy, setKeyBusyState] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  function setKeyBusy(busy: boolean) {
    setKeyBusyState(busy);
    onBusyChange?.(busy);
  }

  // Status only -- never the key itself. Re-read each time the tab is
  // opened so a key saved in another tab is reflected here.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function loadStatus() {
      try {
        const response = await fetch(route);
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          // Without this check a failed status fell through to
          // Boolean(undefined) below, so "your stored key cannot be
          // read" rendered as an ordinary empty field -- visually
          // identical to having never saved one, and silent.
          //
          // That is not a cosmetic difference. On 2026-09-27 it sent a
          // production investigation after a key that had not gone
          // anywhere: the row was intact, the server could not decrypt
          // it, and this tab reported it missing.
          setKeyError(body.error || "Couldn't check your saved key.");
          // Deliberately leaves hasKey alone rather than forcing it
          // false: the honest state here is "unknown", and claiming
          // there is no key is the very mistake being fixed.
          return;
        }
        setKeyError(null);
        setHasKey(Boolean(body.hasKey));
        setKeyHintText(body.hint ?? null);
        onStatus?.(Boolean(body.hasKey));
      } catch {
        if (!cancelled) setKeyError("Couldn't check your saved key.");
      }
    }
    void loadStatus();
    return () => {
      cancelled = true;
    };
    // onStatus is a notification, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, route]);

  // The "show" toggle. Revealing a key already on the server needs a
  // round trip -- the plaintext is deliberately not sent with the status
  // above, so it only leaves the server when the user explicitly asks.
  async function toggleShowKey() {
    if (showKey) {
      setShowKey(false);
      return;
    }
    if (!keyInput && hasKey) {
      setKeyBusy(true);
      setKeyError(null);
      try {
        const response = await fetch(`${route}?reveal=1`);
        const body = await response.json();
        if (response.ok) setKeyInput(body.key ?? "");
        else setKeyError(body.error || "Couldn't reveal your key.");
      } catch {
        setKeyError("Couldn't reveal your key.");
      } finally {
        setKeyBusy(false);
      }
    }
    setShowKey(true);
  }

  async function handleSaveKey() {
    setKeyBusy(true);
    setKeyError(null);
    setKeySaved(false);
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: keyInput }),
      });
      const body = await response.json();
      if (response.ok) {
        setHasKey(true);
        setKeyHintText(body.hint ?? null);
        setKeySaved(true);
        onStatus?.(true);
      } else {
        setKeyError(body.error || "Couldn't save your key.");
      }
    } catch {
      setKeyError("Couldn't save your key — please try again.");
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <>
      <label>
        {label}
        <br />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            // Masked by default. type="password" rather than a
            // hand-rolled mask so browsers and password managers
            // treat it as a secret.
            //
            // Task 72: never in a Session Replay recording. Replay
            // records inputs unmasked (Nik, Task 40) and keeps only
            // password fields masked -- but Show turns this into a
            // text field, which would then be recorded in plain
            // text. ph-no-capture is the recorder's blockClass: the
            // field becomes an empty box in every recording, shown
            // or hidden, and autocapture ignores it too. Every key
            // field is this component, so the OpenAI key has it too.
            className="ph-no-capture"
            type={showKey ? "text" : "password"}
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setKeySaved(false);
            }}
            placeholder={hasKey ? `Saved (${keyHintText ?? "…"})` : placeholder}
            autoComplete="off"
            spellCheck={false}
            disabled={keyBusy}
            style={{ flex: 1, boxSizing: "border-box" }}
          />
          <button
            type="button"
            onClick={() => void toggleShowKey()}
            disabled={keyBusy || (!keyInput && !hasKey)}
          >
            {showKey ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            onClick={() => void handleSaveKey()}
            disabled={keyBusy || !keyInput.trim()}
          >
            {keyBusy ? "Saving..." : "Save"}
          </button>
        </div>
      </label>

      {keyError && <p style={{ color: "#a00" }}>{keyError}</p>}
      {keySaved && !keyError && <p style={{ color: "#060" }}>API key saved.</p>}
    </>
  );
}
