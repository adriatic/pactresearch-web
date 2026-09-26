import { describe, expect, test } from "vitest";
import { MODEL_TIERS, modelForTier, isModelTier } from "@/lib/modelTiers";

// Task 50 item C. modelForTier sits on the execution path -- whatever it
// returns is the model a run actually uses -- so the important property
// is that it can never return something unusable.

describe("modelForTier", () => {
  test("maps the two tiers to their models", () => {
    expect(modelForTier("standard")).toBe("claude-sonnet-4-6");
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

  test("Standard remains the model pact-web used before tiers existed", () => {
    // Guards the intent: adding the picker must not silently change the
    // model for anyone who never opens it.
    expect(MODEL_TIERS.standard.model).toBe("claude-sonnet-4-6");
  });

  test("isModelTier accepts only the two real tiers", () => {
    expect(isModelTier("standard")).toBe(true);
    expect(isModelTier("economy")).toBe(true);
    expect(isModelTier("Standard")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
  });
});
