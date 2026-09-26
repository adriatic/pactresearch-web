import { describe, expect, test } from "vitest";
import { MODEL_TIERS, modelForTier, isModelTier } from "@/lib/modelTiers";

// Task 50 item C. modelForTier sits on the execution path -- whatever it
// returns is the model a run actually uses -- so the important property
// is that it can never return something unusable.

describe("modelForTier", () => {
  test("maps the two tiers to their models", () => {
    expect(modelForTier("standard")).toBe("claude-sonnet-5");
    expect(modelForTier("economy")).toBe("claude-haiku-4-5");
  });

  test("falls back to Standard for anything unrecognised", () => {
    // Covers the normal case (a user who has never chosen a tier) and
    // the defensive ones (a renamed or removed tier still stored on an
    // old user). A run must not fail because of a stale preference.
    for (const value of [undefined, null, "", "premium", 42, {}, ["economy"]]) {
      expect(modelForTier(value)).toBe(MODEL_TIERS.standard.model);
    }
  });

  test("Standard is claude-sonnet-5", () => {
    // Task 50 shipped Standard as claude-sonnet-4-6 specifically so the
    // picker changed nothing for existing users. Nik then chose to move
    // Standard to claude-sonnet-5, which is newer and cheaper. Pinned
    // because this is the model behind every run that has not opted into
    // Economy -- it should only ever change on purpose.
    expect(MODEL_TIERS.standard.model).toBe("claude-sonnet-5");
  });

  test("isModelTier accepts only the two real tiers", () => {
    expect(isModelTier("standard")).toBe(true);
    expect(isModelTier("economy")).toBe(true);
    expect(isModelTier("Standard")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
  });
});
