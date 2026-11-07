import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engines,
  findEngine,
  type Finding,
  type Result,
} from "@/lib/diff/engines";
import {
  asFindings,
  estimateBeforeRun,
  estimateInputTokens,
  MEANING_INSTRUCTION,
  MEANING_MAX_CHARS,
  MEANING_PRICE,
  meaningCounts,
  meaningResult,
  meaningUserMessage,
  usageLine,
} from "@/lib/diff/meaning";
import { ENGINE_TEXT_LIMITS, tooLongMessage } from "@/lib/diff/compareAnswers";

// Task D15. The Meaning engine's pieces that need no server: the
// registry entry and its slots, the counts, the cost estimate and the
// character limit. The route itself is tested in
// __tests__/integration/compare-meaning-route.integration.test.ts.

const meaning = findEngine("meaning");

const finding = (type: Finding["type"], topic = type): Finding => ({
  topic,
  type,
  a: "a",
  b: "b",
  explanation: "e",
});

afterEach(() => vi.unstubAllGlobals());

describe("the Meaning entry in the registry", () => {
  it("is the sixth engine, after Semantic, and its label names the model", () => {
    expect(engines.map((e) => e.id).indexOf("meaning")).toBe(5);
    expect(engines[4].id).toBe("semantic");
    expect(meaning.id).toBe("meaning");
    expect(meaning.label).toBe("Meaning (Claude Opus 5.5)");
  });

  it("fills the slots D12 left open: Compare only, sends to Anthropic, the lab's price", () => {
    expect(meaning.runsOnCompareOnly).toBe(true);
    expect(meaning.sendsTextToProvider).toBe("Anthropic");
    expect(meaning.price).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(MEANING_PRICE).toEqual(meaning.price);
  });

  it("shows findings only", () => {
    expect(meaning.views).toEqual(["findings"]);
  });

  it("is still not the default engine", () => {
    expect(findEngine("no-such-engine").id).toBe("word");
  });
});

describe("Meaning's compare()", () => {
  it("posts the two response ids, never the texts, to pact-web's own route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        findings: [finding("conflict"), finding("agreement")],
        usage: { inputTokens: 3512, outputTokens: 1840 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await meaning.compare("TEXT-A-SECRET", "TEXT-B-SECRET", {
      a: "id-a",
      b: "id-b",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/compare-meaning");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ a: "id-a", b: "id-b" });
    expect(String(init.body)).not.toContain("SECRET");
    expect(result.findings).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 3512, outputTokens: 1840 });
    expect(result.error).toBeUndefined();
  });

  it("carries the route's error message", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          error: "Anthropic rejected your API key. Check it in Account → Keys.",
          code: "anthropic_rejected_key",
        },
        { status: 400 },
      ),
    );
    const result = await meaning.compare("a", "b", { a: "1", b: "2" });
    expect(result.error).toBe(
      "Anthropic rejected your API key. Check it in Account → Keys.",
    );
  });

  it("says so when pact-web's server cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network");
    });
    const result = await meaning.compare("a", "b", { a: "1", b: "2" });
    expect(result.error).toBe("Could not reach pact-web's server. Try again.");
  });

  it("without stored answers' ids, calls nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await meaning.compare("a", "b");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toBe("Meaning compares two stored answers.");
  });
});

describe("Meaning's counts (the lab's meaningCounts)", () => {
  it("conflicting, only in one, uncertain and agreeing", () => {
    const r = meaningResult([
      finding("conflict"),
      finding("conflict"),
      finding("unique"),
      finding("unique"),
      finding("unique"),
      finding("uncertain"),
      finding("agreement"),
    ]);
    expect(meaning.counts(r)).toEqual([
      { text: "2 conflicting", tone: "red" },
      { text: "3 only in one", tone: "green" },
      { text: "~1 uncertain", tone: "amber" },
      { text: "1 agreeing" },
    ]);
    expect(meaning.counts).toBe(meaningCounts);
  });

  it("no findings: all zero", () => {
    expect(meaningCounts(meaningResult([])).map((c) => c.text)).toEqual([
      "0 conflicting",
      "0 only in one",
      "~0 uncertain",
      "0 agreeing",
    ]);
  });

  it("the summary names the model and asks the reader to check", () => {
    expect(meaningResult([]).summary).toBe(
      "Meaning comparison by Claude Opus 5.5 · a model's reading, check what matters",
    );
  });
});

describe("the cost estimate", () => {
  it("counts about four characters per token for the instruction and both answers", () => {
    const a = "x".repeat(4000);
    const b = "y".repeat(4000);
    const sent = MEANING_INSTRUCTION.length + meaningUserMessage(a, b).length;
    expect(estimateInputTokens(a, b)).toBe(Math.ceil(sent / 4));
  });

  it("gives a range at $4 / $20 per million, with 1,000 to 4,000 output tokens", () => {
    const a = "x".repeat(4000);
    const b = "y".repeat(4000);
    const input = estimateInputTokens(a, b);
    const e = estimateBeforeRun(a, b);
    expect(e.low).toBeCloseTo((input * 4 + 1000 * 20) / 1e6, 10);
    expect(e.high).toBeCloseTo((input * 4 + 4000 * 20) / 1e6, 10);
    expect(e.text).toMatch(
      /^Estimated cost: about \$0\.0\d\d to \$0\.\d+\. This is an estimate: about [\d,]+ input tokens at \$4 per million, and 1,000 to 4,000 output tokens at \$20 per million\. Anthropic charges your key for the tokens actually used\.$/,
    );
  });

  it("stays a few cents even at the 20,000-character limit", () => {
    const e = estimateBeforeRun("x".repeat(10_000), "y".repeat(10_000));
    expect(e.low).toBeGreaterThan(0.02);
    expect(e.high).toBeLessThan(0.11);
  });

  it("after a run: the lab's tokens line", () => {
    expect(usageLine({ inputTokens: 3512, outputTokens: 1840 })).toBe(
      "Tokens used: 3,512 input · 1,840 output · estimated cost ≈ $0.051 (estimate at $4 / $20 per million input / output tokens)",
    );
  });
});

describe("the character limit", () => {
  it("is 20,000 characters for the two answers together", () => {
    expect(MEANING_MAX_CHARS).toBe(20_000);
    expect(ENGINE_TEXT_LIMITS.meaning).toBe(20_000);
    expect(
      tooLongMessage("meaning", "a".repeat(10_000), "b".repeat(10_000)),
    ).toBeNull();
  });

  it("one character over: Meaning cannot run, use another engine", () => {
    expect(
      tooLongMessage("meaning", "a".repeat(10_001), "b".repeat(10_000)),
    ).toBe(
      "These two answers are too long for Meaning (Claude Opus 5.5): 20,001 characters together, and Meaning (Claude Opus 5.5) runs on up to 20,000. Meaning cannot run on them; use another engine.",
    );
  });

  it("the other engines' messages are unchanged", () => {
    expect(tooLongMessage("character", "a".repeat(20_001), "")).toMatch(
      /Use Word diff or Line diff\.$/,
    );
    expect(tooLongMessage("word", "a".repeat(80_001), "")).toMatch(
      /Use Line diff\.$/,
    );
  });
});

describe("the answer check (asFindings)", () => {
  it("keeps exactly the Finding fields", () => {
    expect(
      asFindings({
        findings: [{ ...finding("unique"), extra: "dropped" }],
      }),
    ).toEqual([finding("unique")]);
  });

  it("refuses a wrong shape or an unknown type", () => {
    expect(asFindings(null)).toBeNull();
    expect(asFindings({})).toBeNull();
    expect(
      asFindings({ findings: [{ ...finding("unique"), type: "other" }] }),
    ).toBeNull();
    expect(asFindings({ findings: [{ topic: "t" }] })).toBeNull();
  });
});

// Types used above are still the D12 library's.
const _typecheck: Result = meaningResult([]);
void _typecheck;
