import { describe, expect, test } from "vitest";
import {
  formatActivitySummary,
  formatActivityTimestamp,
  formatDuration,
  formatRollupTotal,
} from "@/lib/formatActivity";
import type { ActivityRollup } from "@/lib/activityRollup";

function rollup(over: Partial<ActivityRollup> = {}): ActivityRollup {
  return {
    totalTimeMs: 0,
    runCount: 0,
    firstActivity: "2026-09-25T10:00:00Z",
    lastActivity: "2026-09-25T10:00:00Z",
    hasUnmeasuredActivity: false,
    ...over,
  };
}

describe("formatDuration", () => {
  test("sub-second keeps milliseconds, where they are the only signal", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(940)).toBe("940ms");
  });

  test("seconds, minutes and hours read naturally", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    // 1h 05m 30s. At hour scale the seconds are dropped rather than
    // rounded up -- an hours-long total reported to the second is
    // false precision, and rounding up would overstate it.
    expect(formatDuration(3_930_000)).toBe("1h 05m");
  });

  test("nonsense input degrades to a dash rather than NaN on screen", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

// The rule this task exists for.
describe("formatRollupTotal — a measured zero and an unmeasured one", () => {
  test("unmeasured activity never reads as a bare 0s", () => {
    const out = formatRollupTotal(
      rollup({ totalTimeMs: 0, runCount: 0, hasUnmeasuredActivity: true }),
    );
    expect(out).toBe("Not measured");
    expect(out).not.toMatch(/\b0s\b/);
  });

  test("partly measured shows the measured part, marked approximate", () => {
    expect(
      formatRollupTotal(
        rollup({
          totalTimeMs: 134_000,
          runCount: 3,
          hasUnmeasuredActivity: true,
        }),
      ),
    ).toBe("~2m 14s (partly measured)");
  });

  test("nothing has run reads as such, not as zero duration", () => {
    const out = formatRollupTotal(rollup({ totalTimeMs: 0, runCount: 0 }));
    expect(out).toBe("No runs yet");
    expect(out).not.toMatch(/\b0s\b/);
  });

  test("runs that recorded no time are not reported as instant", () => {
    const out = formatRollupTotal(rollup({ totalTimeMs: 0, runCount: 2 }));
    expect(out).toBe("Not measured");
    expect(out).not.toMatch(/\b0s\b/);
  });

  test("a fully measured total is shown plainly", () => {
    expect(
      formatRollupTotal(rollup({ totalTimeMs: 134_000, runCount: 3 })),
    ).toBe("2m 14s");
  });

  test("no rollup at all renders nothing rather than a placeholder", () => {
    expect(formatRollupTotal(null)).toBe("");
  });

  // Belt and braces: whatever the combination, "0s" must never appear.
  test("no combination of inputs can produce a bare 0s", () => {
    for (const hasUnmeasuredActivity of [true, false]) {
      for (const runCount of [0, 1, 7]) {
        const out = formatRollupTotal(
          rollup({ totalTimeMs: 0, runCount, hasUnmeasuredActivity }),
        );
        expect(
          out,
          JSON.stringify({ hasUnmeasuredActivity, runCount }),
        ).not.toMatch(/\b0s\b/);
      }
    }
  });
});

describe("formatActivityTimestamp", () => {
  test("empty for missing or unparseable input", () => {
    expect(formatActivityTimestamp(null)).toBe("");
    expect(formatActivityTimestamp("not a date")).toBe("");
  });

  test("renders something for a real timestamp", () => {
    expect(
      formatActivityTimestamp("2026-09-25T10:00:00Z").length,
    ).toBeGreaterThan(0);
  });
});

describe("formatActivitySummary", () => {
  test("carries both halves of the original ask: when, and how long", () => {
    const out = formatActivitySummary(
      rollup({ totalTimeMs: 134_000, runCount: 3 }),
    );
    expect(out).toMatch(/^Last activity /);
    expect(out).toContain("2m 14s");
  });

  test("still says the unmeasured state when there is a timestamp", () => {
    const out = formatActivitySummary(
      rollup({ totalTimeMs: 0, hasUnmeasuredActivity: true }),
    );
    expect(out).toContain("Not measured");
    expect(out).not.toMatch(/\b0s\b/);
  });

  test("degrades to the total alone when there is no timestamp", () => {
    expect(
      formatActivitySummary(
        rollup({ totalTimeMs: 134_000, runCount: 1, lastActivity: null }),
      ),
    ).toBe("2m 14s");
  });

  test("nothing at all for a missing rollup", () => {
    expect(formatActivitySummary(null)).toBe("");
  });
});
