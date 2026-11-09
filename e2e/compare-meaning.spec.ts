import { test, expect, type Page } from "@playwright/test";
import {
  engineSelect,
  openComparison,
  pickerA,
  seedCompare,
  TEXT,
} from "./compareHelpers";
import {
  compareButton,
  meaningNote,
  saveMockKey,
  startMockAnthropic,
  type MockAnthropic,
} from "./meaningHelpers";
import {
  contrastSweep,
  expectPageTheme,
  MIN_CONTRAST,
  type ContrastItem,
} from "./themeHelpers";

// Task D15. The Meaning engine on the Compare page, against a local
// stand-in for Anthropic (e2e/meaningHelpers.ts). Nothing real is called.
// Meaning never runs by itself: only the Compare button runs it, and its
// result belongs to the pair of answers it was run for.

test.setTimeout(120_000);

let mock: MockAnthropic;

test.beforeAll(async ({}, workerInfo) => {
  // A port of its own, clear of the other specs' stand-ins.
  mock = await startMockAnthropic(54530 + workerInfo.workerIndex);
});
test.afterAll(async () => {
  await mock.close();
});
test.beforeEach(() => mock.setMode("ok"));

const comparison = (page: Page) =>
  page.getByRole("region", { name: "Comparison" });

const NOTE =
  "Meaning (Claude Opus 5.5) sends both answers to Anthropic, using your own Anthropic key from Account, Keys. It runs only when you press Compare.";
const USAGE_LINE =
  "Tokens used: 3,512 input · 1,840 output · estimated cost ≈ $0.051 (estimate at $4 / $20 per million input / output tokens)";

test("Meaning shows a note and an estimate, runs only on Compare, and shows findings, tokens and cost", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "meaning-run");
  await saveMockKey(page, mock.key);
  const before = mock.calls();

  // Opening it straight from the address does not run it.
  await openComparison(page, seed.answers[0], seed.answers[3], "meaning");
  await expect(engineSelect(page)).toHaveValue("meaning");
  await expect(meaningNote(page)).toContainText(NOTE);
  await expect(page.locator("[data-meaning-estimate]")).toHaveText(
    /^Estimated cost: about \$0\.0\d\d to \$0\.0\d\d\. This is an estimate: about [\d,]+ input tokens at \$4 per million, and 1,000 to 4,000 output tokens at \$20 per million\. Anthropic charges your key for the tokens actually used\.$/,
  );
  await expect(compareButton(page)).toBeEnabled();
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    0,
  );
  await expect(comparison(page).locator("[data-compare-counts]")).toHaveCount(
    0,
  );
  await page.waitForTimeout(1000);
  expect(mock.calls()).toBe(before);

  // Compare: while it runs, the button is disabled and a status shows.
  mock.setMode("slow");
  await compareButton(page).click();
  const status = page.locator("[data-meaning-status]");
  await expect(status).toHaveText(
    "Comparing with Claude Opus 5.5… this can take up to two minutes.",
  );
  await expect(compareButton(page)).toBeDisabled();

  // The findings, the counts, and the tokens with their estimated cost.
  const findings = comparison(page).locator("[data-compare-finding]");
  await expect(findings).toHaveCount(4, { timeout: 15_000 });
  await expect(status).toHaveCount(0);
  await expect(compareButton(page)).toBeEnabled();
  for (const type of ["conflict", "unique", "uncertain", "agreement"]) {
    await expect(comparison(page).locator(`.finding-pill-${type}`)).toHaveCount(
      1,
    );
  }
  await expect(comparison(page)).toContainText("Adapter naming");
  await expect(comparison(page).locator("[data-compare-counts]")).toHaveText(
    "1 conflicting1 only in one~1 uncertain1 agreeing",
  );
  await expect(page.locator("[data-meaning-usage]")).toHaveText(USAGE_LINE);
  await expect(comparison(page)).toContainText(
    "Meaning comparison by Claude Opus 5.5 · a model's reading, check what matters",
  );

  // Exactly one request, with the model, structured output and effort.
  expect(mock.calls()).toBe(before + 1);
  expect(mock.shapes().slice(before)).toEqual([true]);
});

test("switching engines never runs Meaning again; a reload does not either", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "meaning-switch");
  await saveMockKey(page, mock.key);
  await openComparison(page, seed.answers[0], seed.answers[3], "meaning");
  const before = mock.calls();
  await compareButton(page).click();
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    4,
    { timeout: 15_000 },
  );
  expect(mock.calls()).toBe(before + 1);

  // To Word diff and back: the result is still there, nothing was sent.
  await engineSelect(page).selectOption("word");
  await expect(comparison(page).locator(".diff-added").first()).toBeVisible();
  await expect(page.locator("[data-meaning-note]")).toHaveCount(0);
  await engineSelect(page).selectOption("semantic");
  await expect(
    comparison(page).locator("[data-compare-finding]").first(),
  ).toBeVisible();
  await engineSelect(page).selectOption("meaning");
  await expect(page.locator("[data-meaning-usage]")).toBeVisible();
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    4,
  );
  await page.waitForTimeout(1000);
  expect(mock.calls()).toBe(before + 1);

  // A reload starts again from the note, and sends nothing.
  await page.reload();
  await expect(meaningNote(page)).toBeVisible({ timeout: 15_000 });
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    0,
  );
  await page.waitForTimeout(1000);
  expect(mock.calls()).toBe(before + 1);
});

test("choosing another answer for A clears the old Meaning result", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "meaning-clear");
  await saveMockKey(page, mock.key);
  await openComparison(page, seed.answers[0], seed.answers[3], "meaning");
  const before = mock.calls();
  await compareButton(page).click();
  await expect(page.locator("[data-meaning-usage]")).toBeVisible({
    timeout: 15_000,
  });

  await pickerA(page).selectOption(seed.answers[1]);
  await expect(page).toHaveURL(new RegExp(`a=${seed.answers[1]}`));
  await expect(
    page.getByRole("region", { name: "Chosen answer A" }),
  ).toContainText("A · answer 2");
  await expect(meaningNote(page)).toBeVisible();
  await expect(page.locator("[data-meaning-usage]")).toHaveCount(0);
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    0,
  );
  await expect(comparison(page).locator("[data-compare-counts]")).toHaveCount(
    0,
  );

  // Going back to the first pair does not bring the old result back.
  await pickerA(page).selectOption(seed.answers[0]);
  await expect(page).toHaveURL(new RegExp(`a=${seed.answers[0]}`));
  await expect(comparison(page).locator("[data-compare-finding]")).toHaveCount(
    0,
  );
  await page.waitForTimeout(1000);
  expect(mock.calls()).toBe(before + 1);
});

test("the states: no key, unreadable key, rejected key, a failed call, too long, not found", async ({
  page,
  context,
}) => {
  const long = (TEXT.first + "\n").repeat(60); // about 11,000 characters
  const longOther = (TEXT.fourth + "\n").repeat(60);
  const seed = await seedCompare(context, "meaning-states", [
    TEXT.first,
    TEXT.second,
    long,
    longOther,
  ]);
  const [first, second, longA, longB] = seed.answers;
  const error = comparison(page).locator("[data-compare-error]");
  const before = mock.calls();

  // No key saved: where to add it.
  await openComparison(page, first, second, "meaning");
  await compareButton(page).click();
  await expect(error).toHaveText(
    "Add your Anthropic API key in Account → Keys before running prompts.",
  );
  await expect(comparison(page).locator("[data-compare-counts]")).toHaveCount(
    0,
  );

  // A stored key that cannot be read.
  await seed.admin.from("user_api_keys").upsert({
    user_id: seed.userId,
    anthropic_key_encrypted: "not-a-readable-stored-key",
  });
  await openComparison(page, first, second, "meaning");
  await compareButton(page).click();
  await expect(error).toHaveText(
    "Your saved Anthropic API key could not be read. Open Account → Keys and save it again.",
  );
  expect(mock.calls()).toBe(before);

  // Anthropic rejects the key.
  await saveMockKey(page, mock.key);
  mock.setMode("reject");
  await openComparison(page, first, second, "meaning");
  await compareButton(page).click();
  // Task D17i: the shared refused-key words changed.
  await expect(error).toHaveText(
    "Anthropic rejected your API key. It may have been deleted, disabled or expired in the Anthropic console, or saved with a typing error. Compare it with the console, then fix it in Account → Keys.",
  );

  // Anthropic fails: the route's message, without the texts.
  mock.setMode("error");
  await compareButton(page).click();
  await expect(error).toHaveText(
    "Anthropic answered with an error (HTTP 500); check your Anthropic account's credit and limits.",
  );
  await expect(error).not.toContainText("central execution engine");
  expect(mock.calls()).toBe(before + 2);

  // Too long: no note, no button, nothing sent.
  mock.setMode("ok");
  await openComparison(page, longA, longB, "meaning");
  await expect(comparison(page).locator("[data-compare-too-long]")).toHaveText(
    /^These two answers are too long for Meaning \(Claude Opus 5\.5\): [\d,]+ characters together, and Meaning \(Claude Opus 5\.5\) runs on up to 20,000\. Meaning cannot run on them; use another engine\.$/,
  );
  await expect(meaningNote(page)).toHaveCount(0);
  await expect(compareButton(page)).toHaveCount(0);
  expect(mock.calls()).toBe(before + 2);

  // Another user's answer: Response not found, as for every engine.
  await page.goto(
    `/compare?a=${first}&b=${seed.strangerAnswer}&engine=meaning`,
  );
  await expect(page.locator('[data-compare-not-found="B"]')).toHaveText(
    "Response not found",
    { timeout: 15_000 },
  );
  await expect(comparison(page)).toHaveCount(0);
  await expect(compareButton(page)).toHaveCount(0);
});

test("signed out, the Meaning route answers 401 and sends nothing", async ({
  request,
}) => {
  const before = mock.calls();
  const response = await request.post("/api/compare-meaning", {
    data: {
      a: "00000000-0000-4000-8000-000000000000",
      b: "00000000-0000-4000-8000-000000000001",
    },
  });
  expect(response.status()).toBe(401);
  expect(mock.calls()).toBe(before);
});

// Every new element reaches 4.5:1 on a light and on a dark device.
function expectReadable(items: ContrastItem[], where: string) {
  expect(items.length, `${where}: something was measured`).toBeGreaterThan(0);
  const below = items.filter((i) => i.ratio < MIN_CONTRAST);
  expect(
    below.map((i) => `${where}: "${i.text}" ${i.fg} on ${i.bg} = ${i.ratio}`),
  ).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test(`contrast sweep of the Meaning states on a ${scheme} device`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const long = (TEXT.first + "\n").repeat(60);
    const longOther = (TEXT.fourth + "\n").repeat(60);
    const seed = await seedCompare(context, `meaning-sweep-${scheme}`, [
      TEXT.first,
      TEXT.fourth,
      long,
      longOther,
    ]);
    const [first, fourth, longA, longB] = seed.answers;
    const sweep = () => contrastSweep(page.locator("main"));

    // The note, the estimate and the button, before a run (no key yet).
    await openComparison(page, first, fourth, "meaning");
    await expectPageTheme(page, scheme);
    await expect(meaningNote(page)).toBeVisible();
    const note = await sweep();
    for (const needed of ["sends both answers", "Estimated cost", "Compare"]) {
      expect(
        note.some((i) => i.text.includes(needed)),
        `measured: ${needed}`,
      ).toBe(true);
    }
    expectReadable(note, "note");

    // An error: no key saved.
    await compareButton(page).click();
    await expect(
      comparison(page).locator("[data-compare-error]"),
    ).toBeVisible();
    expectReadable(await sweep(), "no key");

    // A run in progress: the status.
    await saveMockKey(page, mock.key);
    mock.setMode("slow");
    await compareButton(page).click();
    await expect(page.locator("[data-meaning-status]")).toBeVisible();
    const running = await sweep();
    expect(
      running.some((i) => i.text.includes("Comparing with")),
      "measured: the status",
    ).toBe(true);
    expectReadable(running, "running");

    // The result: four pills, the counts and the tokens line.
    await expect(
      comparison(page).locator("[data-compare-finding]"),
    ).toHaveCount(4, { timeout: 15_000 });
    const done = await sweep();
    for (const needed of [
      "conflicting",
      "agreeing",
      "Tokens used",
      "uncertain",
    ]) {
      expect(
        done.some((i) => i.text.includes(needed)),
        `measured: ${needed}`,
      ).toBe(true);
    }
    expectReadable(done, "result");

    // Too long.
    await openComparison(page, longA, longB, "meaning");
    await expect(
      comparison(page).locator("[data-compare-too-long]"),
    ).toBeVisible();
    expectReadable(await sweep(), "too long");
  });
}
