"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { ApiKeyField } from "./ApiKeyField";

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

  // ---- Task 51: Keys tab (fields in ApiKeyField.tsx since Task 81) ----
  const [keyBusyCount, setKeyBusyCount] = useState(0);
  const keyBusy = keyBusyCount > 0;
  const onKeyBusy = (busy: boolean) =>
    setKeyBusyCount((n) => Math.max(0, n + (busy ? 1 : -1)));
  // Task 81: the ChatGPT section is closed until it is wanted -- a user
  // who never adds an OpenAI key sees one closed line -- and opens by
  // itself when an OpenAI key is saved.
  const [openAiOpen, setOpenAiOpen] = useState(false);

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
        {/* Task 80. Sign out was a link in the old dashboard header
            (87acbbc, June); the August placeholder removed the dashboard,
            and when the app came back only the /logout route returned.
            It sits next to the heading so it is in reach on both tabs and
            stays near the top when the iPad keyboard shortens the dialog.
            A real form POST, not a link: nothing can prefetch it, and the
            route answers with a redirect to the sign-in page. 44px is
            Apple's minimum comfortable tap height. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>Account</h2>
          <form method="post" action="/logout" style={{ margin: 0 }}>
            <button type="submit" style={{ minHeight: 44, minWidth: 96 }}>
              Sign out
            </button>
          </form>
        </div>

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

            <ApiKeyField
              route="/api/account/anthropic-key"
              label="Anthropic API key:"
              placeholder="sk-ant-..."
              active={open && tab === "keys"}
              onBusyChange={onKeyBusy}
            />

            {/* Task 81 Stage 2. Optional: needed only to run prompts on
                ChatGPT. */}
            <details
              open={openAiOpen}
              onToggle={(e) => setOpenAiOpen(e.currentTarget.open)}
              style={{ margin: "12px 0" }}
            >
              <summary style={{ cursor: "pointer" }}>
                ChatGPT (optional)
              </summary>
              <div role="group" aria-label="OpenAI key">
                <p style={{ color: "#666", fontSize: "0.9em" }}>
                  Only needed to run prompts on ChatGPT. Get a key at{" "}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    platform.openai.com/api-keys
                  </a>
                  . OpenAI bills API use separately from a ChatGPT subscription.
                </p>
                <ApiKeyField
                  route="/api/account/openai-key"
                  label="OpenAI API key:"
                  placeholder="sk-..."
                  active={open && tab === "keys"}
                  onStatus={(hasKey) => {
                    if (hasKey) setOpenAiOpen(true);
                  }}
                  onBusyChange={onKeyBusy}
                />
              </div>
            </details>

            <div>
              <button type="button" onClick={onClose} disabled={keyBusy}>
                Close
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
