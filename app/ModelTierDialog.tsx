"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { MODEL_TIERS, type ModelTier } from "@/lib/modelTiers";

// Task 50 item C. Model tier picker.
//
// Unlike the other two dialogs in this task, this one really does apply
// immediately -- selecting a tier saves it and closes. So there is no
// Save button, and saying "changes are saved immediately" here would
// actually be true; it is left off anyway because the behaviour is
// self-evident from a list you click once.
//
// Nothing is pre-selected when it opens, per the spec. That is a
// deliberate difference from showing the current tier: the control is a
// "change it to" list, not a settings display.
//
// Scope is per user, stored in auth user_metadata alongside the profile
// -- no migration, and /api/execute already has the auth user in hand so
// reading it costs nothing. GPT/OpenAI options are out of scope here;
// each tier shows only the Claude model it maps to.

export function ModelTierDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [applying, setApplying] = useState<ModelTier | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function choose(tier: ModelTier) {
    if (applying) return;
    setApplying(tier);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        data: { model_tier: tier },
      });
      if (updateError) {
        setError("Couldn't apply that tier.");
        setApplying(null);
        return;
      }
      onClose();
    } catch {
      setError("Couldn't apply that tier — please try again.");
      setApplying(null);
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
        aria-label="Model tier"
        style={{
          background: "#fff",
          border: "1px solid #999",
          padding: 16,
          width: 480,
          maxWidth: "90vw",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Model tier</h2>
        <p style={{ marginTop: 0, color: "#666", fontSize: "0.9em" }}>
          Choosing a tier applies it right away.
        </p>

        {(Object.keys(MODEL_TIERS) as ModelTier[]).map((tier) => {
          const { label, model, description } = MODEL_TIERS[tier];
          return (
            <button
              key={tier}
              type="button"
              onClick={() => void choose(tier)}
              disabled={applying !== null}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                marginBottom: 8,
                padding: 8,
              }}
            >
              <strong>{label}</strong>
              {applying === tier ? " — applying..." : ""}
              <br />
              <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
                {model}
              </span>
              <br />
              <span style={{ color: "#666", fontSize: "0.9em" }}>
                {description}
              </span>
            </button>
          );
        })}

        {error && <p style={{ color: "#a00" }}>{error}</p>}

        <button type="button" onClick={onClose} disabled={applying !== null}>
          Cancel
        </button>
      </section>
    </div>
  );
}
