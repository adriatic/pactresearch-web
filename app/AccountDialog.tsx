"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

// Task 50 item A. Account modal, Profile section.
//
// Storage: Supabase auth user_metadata, not a new table. Everything here
// is per-user and small, the auth user is already fetched on every
// request, and it needs no migration -- which matters because a schema
// change cannot reach production without a separate review step. If a
// profile ever needs to be queried across users (it does not today), a
// real table is the right move then.
//
// The email field is profile contact information, prefilled from the
// sign-in address. It deliberately does NOT call updateUser({ email }):
// that changes the auth identity and triggers a confirmation email,
// which is a different feature with a different flow, and not something
// a Save button on a profile form should do silently.
//
// Tabs exist so task 51 can add "Keys" without restructuring this. The
// Keys tab is rendered and visibly disabled rather than hidden -- it
// says where that work lands, and keeps the tab strip from changing
// shape when it arrives.
//
// No "changes are saved immediately" subtitle: Save here is explicit,
// and the claim would be false. Same reasoning as SettingsDialog.

type Tab = "profile" | "keys";

export function AccountDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [useCase, setUseCase] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reset during render when the dialog opens, then fetch in the effect
  // below. Same split SettingsDialog uses: this repo's lint config
  // rejects a synchronous setState inside an effect body
  // (react-hooks/set-state-in-effect), so the reset is keyed on a
  // derived value at render time instead.
  const openKey = open ? "open" : null;
  const [loadedForKey, setLoadedForKey] = useState<string | null>(null);
  if (openKey !== loadedForKey) {
    setLoadedForKey(openKey);
    if (openKey !== null) {
      setLoading(true);
      setError(null);
      setSaved(false);
    }
  }

  // Re-fetched every time it opens rather than cached, so a profile
  // changed in another tab is never silently overwritten on Save, and
  // closing without saving genuinely discards the edits.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadProfile() {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        const user = data.user;
        const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
        setName(typeof meta.full_name === "string" ? meta.full_name : "");
        setUseCase(
          typeof meta.pact_use_case === "string" ? meta.pact_use_case : "",
        );
        setEmail(
          typeof meta.contact_email === "string" && meta.contact_email
            ? meta.contact_email
            : (user?.email ?? ""),
        );
      } catch {
        if (!cancelled) setError("Couldn't load your profile.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ---- Task 51: Keys tab ----
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyHintText, setKeyHintText] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  // Status only -- never the key itself. Re-read each time the tab is
  // opened so a key saved in another tab is reflected here.
  useEffect(() => {
    if (!open || tab !== "keys") return;
    let cancelled = false;
    async function loadStatus() {
      try {
        const response = await fetch("/api/account/anthropic-key");
        const body = await response.json();
        if (cancelled) return;
        setHasKey(Boolean(body.hasKey));
        setKeyHintText(body.hint ?? null);
      } catch {
        if (!cancelled) setKeyError("Couldn't check your saved key.");
      }
    }
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

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
        const response = await fetch("/api/account/anthropic-key?reveal=1");
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
      const response = await fetch("/api/account/anthropic-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: keyInput }),
      });
      const body = await response.json();
      if (response.ok) {
        setHasKey(true);
        setKeyHintText(body.hint ?? null);
        setKeySaved(true);
      } else {
        setKeyError(body.error || "Couldn't save your key.");
      }
    } catch {
      setKeyError("Couldn't save your key — please try again.");
    } finally {
      setKeyBusy(false);
    }
  }

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: name,
          contact_email: email,
          pact_use_case: useCase,
        },
      });
      if (updateError) {
        setError("Couldn't save your profile.");
      } else {
        setSaved(true);
      }
    } catch {
      setError("Couldn't save your profile — please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <section
        role="dialog"
        aria-label="Account"
        style={{
          background: "#fff",
          border: "1px solid #999",
          padding: 16,
          width: 480,
          maxWidth: "90vw",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Account</h2>

        <div
          role="tablist"
          aria-label="Account sections"
          style={{ marginBottom: 12 }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "profile"}
            onClick={() => setTab("profile")}
            style={{ fontWeight: tab === "profile" ? "bold" : "normal" }}
          >
            Profile
          </button>{" "}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "keys"}
            onClick={() => setTab("keys")}
            style={{ fontWeight: tab === "keys" ? "bold" : "normal" }}
          >
            Keys
          </button>
        </div>

        {tab === "profile" && (
          <div role="tabpanel" aria-label="Profile">
            <label>
              Your name:
              <br />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading || saving}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </label>
            <br />
            <label>
              Email address:
              <br />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading || saving}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </label>
            <br />
            <label>
              What will you use PACT for? (optional)
              <br />
              <textarea
                value={useCase}
                onChange={(e) => setUseCase(e.target.value)}
                rows={4}
                disabled={loading || saving}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </label>

            {error && <p style={{ color: "#a00" }}>{error}</p>}
            {saved && !error && <p style={{ color: "#060" }}>Profile saved.</p>}

            <div>
              <button type="button" onClick={onClose} disabled={saving}>
                Close
              </button>{" "}
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={loading || saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        )}

        {tab === "keys" && (
          <div role="tabpanel" aria-label="Keys">
            {/* Task 51. Anthropic only -- OpenAI is explicitly out of
                scope here, same as the Model tier selector. */}
            <p style={{ marginTop: 0, color: "#666", fontSize: "0.9em" }}>
              Your runs use your own Anthropic key. Get one at{" "}
              <a
                href="https://console.anthropic.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                console.anthropic.com
              </a>
              .
            </p>

            <label>
              Anthropic API key:
              <br />
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  // Masked by default. type="password" rather than a
                  // hand-rolled mask so browsers and password managers
                  // treat it as a secret.
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    setKeySaved(false);
                  }}
                  placeholder={
                    hasKey ? `Saved (${keyHintText ?? "…"})` : "sk-ant-..."
                  }
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
              </div>
            </label>

            {keyError && <p style={{ color: "#a00" }}>{keyError}</p>}
            {keySaved && !keyError && (
              <p style={{ color: "#060" }}>API key saved.</p>
            )}

            <div>
              <button type="button" onClick={onClose} disabled={keyBusy}>
                Close
              </button>{" "}
              <button
                type="button"
                onClick={() => void handleSaveKey()}
                disabled={keyBusy || !keyInput.trim()}
              >
                {keyBusy ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
