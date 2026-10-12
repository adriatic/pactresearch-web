"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import {
  DEFAULT_PROVIDER,
  LLM_PROVIDERS,
  providerFrom,
  type LlmProviderId,
} from "@/lib/llmProviders";
import { DEFAULT_TIER, isModelTier, type ModelTier } from "@/lib/modelTiers";

// Task 81 Stage 2. The user's provider (Claude or ChatGPT) and tier, as
// stored in their user_metadata, for the header's provider dropdown and
// the Model tier dialog. /api/execute reads the same two values from the
// user on every run; this only shows them and changes the provider.
export function useLlmChoice() {
  const [provider, setProvider] = useState<LlmProviderId>(DEFAULT_PROVIDER);
  const [tier, setTier] = useState<ModelTier>(DEFAULT_TIER);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to read the stored values again (after the tier dialog).
  const [readCount, setReadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled) return;
        const meta = (data.user?.user_metadata ?? {}) as Record<
          string,
          unknown
        >;
        setProvider(providerFrom(meta.llm_provider));
        setTier(isModelTier(meta.model_tier) ? meta.model_tier : DEFAULT_TIER);
      })
      .catch(() => {
        // Shown as the defaults; the run itself reads the stored values.
      });
    return () => {
      cancelled = true;
    };
  }, [readCount]);

  // Saved before it counts: Run waits while `saving`, so a run started
  // right after a switch goes to the provider the dropdown shows.
  async function choose(next: LlmProviderId) {
    if (next === provider || saving) return;
    const previous = provider;
    setProvider(next);
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await createClient().auth.updateUser({
        data: { llm_provider: next },
      });
      if (updateError) throw updateError;
    } catch {
      setProvider(previous);
      setError(`Couldn't switch to ${LLM_PROVIDERS[next].label}.`);
    } finally {
      setSaving(false);
    }
  }

  return {
    provider,
    tier,
    saving,
    error,
    choose,
    reread: () => setReadCount((n) => n + 1),
  };
}
