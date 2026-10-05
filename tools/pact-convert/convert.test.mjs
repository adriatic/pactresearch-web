// Tests for the one-time .pact converter (Task 77). Fixtures in ./fixtures
// keep the structure of real older files with all text synthetic.
// Deleting this folder removes these tests with the converter.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { validatePactExport } from "../../lib/pactExport";
import { ConvertError, convertText, run } from "./convert.mjs";

const FIXTURES = join(__dirname, "fixtures");
const read = (name) => readFileSync(join(FIXTURES, name), "utf8");
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "pact-convert-"));
const quiet = () => {};

describe("older formats convert to files pact-web's importer accepts", () => {
  test("the extension's signed export: unwrapped, removed fields listed", () => {
    const r = convertText(read("signed-pact-local-with-xmstate.pact"));
    expect(r.status).toBe("converted");
    expect(r.notCarriedOver).toEqual([
      "signature (signed by pact-local): pact-web does not verify or keep .pact signatures.",
      "xmState: the desktop app's navigation state (open discussion, contents list, scroll position). pact-web has no equivalent.",
      'notebook.executionMode ("index"): pact-web notebooks are interactive-only, so the mode is not kept.',
    ]);
    const out = JSON.parse(r.output);
    expect(Object.keys(out)).toEqual([
      "version",
      "exportedAt",
      "notebook",
      "discussions",
      "cells",
    ]);
    expect(out.notebook).toEqual({
      name: "Fixture signed extension notebook",
      systemPrompt: "Synthetic system prompt.",
      category: "dev-tests",
    });
    const parsed = validatePactExport(out);
    expect(parsed.discussions).toHaveLength(2);
    expect(parsed.cells).toHaveLength(4);
  });

  test("the legacy app's signed export keeps every cell and model", () => {
    const original = JSON.parse(read("signed-pactresearch-net.pact"));
    const r = convertText(JSON.stringify(original));
    expect(r.notCarriedOver).toEqual([
      "signature (signed by pactresearch.net): pact-web does not verify or keep .pact signatures.",
    ]);
    // Apart from the envelope, the content is exactly the payload.
    expect(JSON.parse(r.output)).toEqual(original.payload);
    expect(
      validatePactExport(JSON.parse(r.output)).cells[0].resolvedModel,
    ).toBe("claude-sonnet-4-6");
  });

  test("a payload stored as a JSON string is read too", () => {
    const signed = JSON.parse(read("signed-pactresearch-net.pact"));
    const r = convertText(
      JSON.stringify({ ...signed, payload: JSON.stringify(signed.payload) }),
    );
    expect(JSON.parse(r.output)).toEqual(signed.payload);
  });

  test("a signer that is not a short label is not echoed", () => {
    const signed = JSON.parse(read("signed-pactresearch-net.pact"));
    const r = convertText(
      JSON.stringify({ ...signed, signer: "<script>x</script>" }),
    );
    expect(r.notCarriedOver[0]).toMatch(/signed by an unknown signer/);
  });

  test("plain pact-mac: execution mode removed and listed, category kept", () => {
    const r = convertText(read("plain-pact-mac-category-mode.pact"));
    expect(r.status).toBe("converted");
    expect(r.notCarriedOver).toEqual([
      'notebook.executionMode ("interactive"): pact-web notebooks are interactive-only, so the mode is not kept.',
    ]);
    expect(validatePactExport(JSON.parse(r.output)).notebook.category).toBe(
      "user-requests",
    );
  });

  test("an unknown cell field is removed and reported once with its count", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    file.cells[0].rating = 5;
    const r = convertText(JSON.stringify(file));
    expect(r.notCarriedOver).toEqual([
      "cells.rating (in 1 of 2): not part of pact-web's notebook format.",
    ]);
    expect("rating" in JSON.parse(r.output).cells[0]).toBe(false);
  });
});

describe("files already in the current format", () => {
  test.each([
    "plain-old-minimal.pact",
    "plain-old-gpt-parent-chain.pact",
    "plain-early-pact-web-no-cells.pact",
  ])("%s is reported current and needs no output", (name) => {
    const r = convertText(read(name));
    expect(r.status).toBe("current");
    expect(r.output).toBeNull();
    expect(r.notCarriedOver).toEqual([]);
    validatePactExport(JSON.parse(read(name)));
  });

  test("converting a converted file changes nothing", () => {
    const once = convertText(read("signed-pact-local-with-xmstate.pact"));
    const twice = convertText(once.output);
    expect(twice.status).toBe("current");
    expect(twice.notCarriedOver).toEqual([]);
  });
});

describe("files that cannot be converted fail clearly", () => {
  test.each([
    ["truncated", read("truncated.pact"), /may be truncated/],
    ["not JSON at all", "hello", /Not valid JSON/],
    [
      "JSON that is not a .pact",
      '{"hello":"world"}',
      /no format version and no notebook/,
    ],
    ["a JSON array", "[]", /expected a JSON object/],
    [
      "a future version",
      JSON.stringify({ version: 2, notebook: {} }),
      /Unsupported .pact version 2/,
    ],
    [
      "a signed envelope of another version",
      JSON.stringify({
        ...JSON.parse(read("signed-pactresearch-net.pact")),
        version: 2,
      }),
      /Unsupported signed .pact version 2/,
    ],
    [
      "an unreadable signed payload",
      JSON.stringify({
        ...JSON.parse(read("signed-pactresearch-net.pact")),
        payload: "{x",
      }),
      /signed payload is not readable JSON/,
    ],
  ])("%s", (_, text, message) => {
    expect(() => convertText(text)).toThrow(ConvertError);
    expect(() => convertText(text)).toThrow(message);
  });

  test("a timestamp that is not a real date is refused, naming the field", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    file.cells[1].createdAt = 1e20;
    expect(() => convertText(JSON.stringify(file))).toThrow(
      "cells[1].createdAt is not a valid date.",
    );
  });

  test("a missing required field is refused, naming it", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    delete file.cells[0].response;
    expect(() => convertText(JSON.stringify(file))).toThrow(
      "cells[0].response must be a string.",
    );
  });
});

describe("observations are reported without changing anything", () => {
  test("prompts that were never run", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    file.cells[0].response = "";
    const r = convertText(JSON.stringify(file));
    expect(r.status).toBe("current");
    expect(r.notes).toEqual([
      '1 of 2 prompts were never run (empty response); kept as-is, pact-web shows them as "never run".',
    ]);
  });

  test("literal \\n with no real line breaks", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    file.cells[0].promptText = "Line one.\\n\\nLine two.";
    const r = convertText(JSON.stringify(file));
    expect(r.notes.join(" ")).toMatch(
      /Literal "\\n" .* cells\[0\]\.promptText; kept exactly as written/,
    );
    expect(r.status).toBe("current");
  });
});

describe("the command line", () => {
  test("writes converted files, copies current ones byte for byte, writes nothing for errors, never touches originals", () => {
    const names = readdirSync(FIXTURES);
    const before = Object.fromEntries(
      names.map((n) => [n, sha(join(FIXTURES, n))]),
    );
    const out = join(tmp(), "out");

    const results = run(["--out", out, FIXTURES], quiet);

    const after = Object.fromEntries(
      names.map((n) => [n, sha(join(FIXTURES, n))]),
    );
    expect(after).toEqual(before);

    const target = (n) => join(out, "fixtures", n);
    expect(sha(target("plain-old-minimal.pact"))).toBe(
      before["plain-old-minimal.pact"],
    );
    validatePactExport(
      JSON.parse(
        readFileSync(target("signed-pact-local-with-xmstate.pact"), "utf8"),
      ),
    );
    expect(existsSync(target("truncated.pact"))).toBe(false);

    expect(results.filter((r) => r.status === "error")).toHaveLength(1);
    const report = readFileSync(join(out, "conversion-report.txt"), "utf8");
    expect(report).toContain(
      "4 converted, 3 already current (copied unchanged), 1 errors.",
    );
    expect(report).toContain("not carried over: xmState");
  });

  test("a dry run writes nothing", () => {
    const out = join(tmp(), "out");
    run(["--out", out, "--dry-run", FIXTURES], quiet);
    expect(existsSync(out)).toBe(false);
  });

  test("never overwrites an existing output file", () => {
    const out = join(tmp(), "out");
    run(["--out", out, join(FIXTURES, "plain-old-minimal.pact")], quiet);
    const second = run(
      ["--out", out, join(FIXTURES, "plain-old-minimal.pact")],
      quiet,
    );
    expect(second[0].status).toBe("error");
    expect(second[0].error).toMatch(/Output already exists/);
  });

  test("refuses an output folder inside an input folder", () => {
    const input = tmp();
    writeFileSync(join(input, "a.pact"), read("plain-old-minimal.pact"));
    expect(() =>
      run(["--out", join(input, "converted"), input], quiet),
    ).toThrow(/--out must be outside the inputs/);
  });
});

// Legacy referenced-cell context (approved 2026-10-05). The fixture copies
// the real nesting structure with synthetic text: d1 asks Q0; d2 quotes
// Q0 + d1's answer and asks Q1 (run twice); d3 quotes two levels deep.
describe("legacy referenced-cell context", () => {
  const FILE = "signed-pactresearch-net-referenced-cells.pact";
  const payload = () => JSON.parse(read(FILE)).payload;
  const asSigned = (p) =>
    JSON.stringify({ ...JSON.parse(read(FILE)), payload: p });

  test("each quoted prompt becomes its own question, verified, and nothing else changes", () => {
    const original = payload();
    const r = convertText(read(FILE));
    const out = JSON.parse(r.output);
    expect(out.cells.map((c) => c.promptText)).toEqual([
      "Synthetic question one.\nWith a second line.",
      "Synthetic follow-up two?",
      "Synthetic follow-up two?",
      "Synthetic follow-up three?",
    ]);
    expect(out.cells.map((c) => c.response)).toEqual(
      original.cells.map((c) => c.response),
    );
    expect(r.notes[0]).toMatch(
      /^Unwrapped legacy referenced-cell context in 3 of 4 prompts \(cells\[1\], cells\[2\], cells\[3\]\); \d+ characters of quoted earlier entries removed/,
    );
    validatePactExport(out);
  });

  test("a quoted answer that differs from the earlier entry leaves that prompt as written", () => {
    const p = payload();
    p.cells[3].promptText = p.cells[3].promptText.replace(
      "Synthetic answer two, second run.",
      "Synthetic answer two, EDITED.",
    );
    const r = convertText(asSigned(p));
    const out = JSON.parse(r.output);
    expect(out.cells[3].promptText).toBe(p.cells[3].promptText);
    expect(out.cells[1].promptText).toBe("Synthetic follow-up two?");
    expect(r.notes).toContain(
      "Not unwrapped, left as written: cells[3] has legacy referenced-cell context, but quoted answer 2 matches no earlier entry.",
    );
  });

  test("an answer that itself contains a quoted-response marker is not guessed at", () => {
    const p = payload();
    const tricky = "Synthetic answer one.\nResponse: looks like a marker";
    p.cells[0].response = tricky;
    p.cells[1].promptText = p.cells[1].promptText.replace(
      "Synthetic answer one.\n\n- point",
      tricky,
    );
    const r = convertText(asSigned(p));
    expect(JSON.parse(r.output).cells[1].promptText).toBe(
      p.cells[1].promptText,
    );
    expect(r.notes.join(" ")).toMatch(
      /cells\[1\] .* expected 2 pieces for 1 reference\(s\), found 3/,
    );
  });

  test("a quote with nothing after it is left as written", () => {
    const p = payload();
    p.cells[1].promptText =
      "[Referenced Cell]\nPrompt: Synthetic question one.\nWith a second line.\nResponse: Synthetic answer one.\n\n- point\n";
    const r = convertText(asSigned(p));
    expect(JSON.parse(r.output).cells[1].promptText).toBe(
      p.cells[1].promptText,
    );
    expect(r.notes.join(" ")).toMatch(
      /cells\[1\] .* nothing would remain of the question/,
    );
  });

  test("the placeholder anywhere but the start is not touched", () => {
    const file = JSON.parse(read("plain-old-minimal.pact"));
    file.cells[0].promptText = "Intro.\n[Referenced Cell]\nPrompt: not leading";
    const r = convertText(JSON.stringify(file));
    expect(r.status).toBe("current");
  });

  test("converting the converted file again changes nothing", () => {
    const once = convertText(read(FILE));
    const twice = convertText(once.output);
    expect(twice.status).toBe("current");
    expect(twice.notes).toEqual([]);
  });
});
