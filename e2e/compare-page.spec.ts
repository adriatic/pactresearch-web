import { test, expect } from "@playwright/test";
import {
  engineSelect,
  openComparison,
  pickerA,
  pickerB,
  SEMANTIC,
  seedCompare,
  TEXT,
} from "./compareHelpers";

// Task D13. The Compare page, /compare?a=<id>&b=<id>[&engine=...]: two
// pickers over the signed-in user's stored answers, the two prompts, and
// the D12 engines' result. Local seeded data only.

test.setTimeout(90_000);

test("both pickers list all of the user's answers and none of another user's", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-list");
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: "Compare answers" }),
  ).toBeVisible({ timeout: 15_000 });
  // Pickers only: no comparison yet.
  await expect(page.getByRole("region", { name: "Comparison" })).toHaveCount(0);

  for (const picker of [pickerA(page), pickerB(page)]) {
    const values = await picker
      .locator("option")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.filter(Boolean).sort()).toEqual([...seed.answers].sort());
    expect(values).not.toContain(seed.strangerAnswer);

    // Grouped as "notebook › discussion", answers numbered in order.
    const groups = await picker
      .locator("optgroup")
      .evaluateAll((gs) => gs.map((g) => (g as HTMLOptGroupElement).label));
    expect(groups).toEqual([
      `${seed.otherNotebookName} › ${seed.otherDiscussionName}`,
      `${seed.notebookName} › ${seed.discussionName}`,
    ]);
    const texts = await picker
      .locator("optgroup")
      .nth(1)
      .locator("option")
      .allTextContents();
    expect(texts.map((t) => t.split(" · ").slice(0, 3).join(" · "))).toEqual([
      "answer 1 · Claude · claude-sonnet-5",
      "answer 2 · Claude · claude-sonnet-5",
      "answer 3 · Claude · claude-sonnet-5",
      "answer 4 · ChatGPT · gpt-6.1-sol",
    ]);
  }
  await expect(
    page.getByRole("link", { name: "Back to the workspace" }),
  ).toHaveAttribute("href", "/");
});

test("choosing answer 2 and answer 4 of one discussion compares them, and the address holds both", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-choose");
  await page.goto("/compare");
  await pickerA(page).selectOption(seed.answers[1]);
  await expect(page).toHaveURL(new RegExp(`a=${seed.answers[1]}`));
  await pickerB(page).selectOption(seed.answers[3]);
  await expect(page).toHaveURL(
    new RegExp(`a=${seed.answers[1]}&b=${seed.answers[3]}`),
  );

  const comparison = page.getByRole("region", { name: "Comparison" });
  await expect(comparison).toBeVisible();
  // Each side: its prompt, its model label and its place.
  const sideA = page.getByRole("region", { name: "Chosen answer A" });
  const sideB = page.getByRole("region", { name: "Chosen answer B" });
  await expect(sideA).toContainText("A · answer 2");
  await expect(sideA).toContainText("Prompt for answer 2");
  await expect(sideA).toContainText("Claude · claude-sonnet-5");
  await expect(sideB).toContainText("B · answer 4");
  await expect(sideB).toContainText("Prompt for answer 4");
  await expect(sideB).toContainText("ChatGPT · gpt-6.1-sol");
  await expect(sideB).toContainText(seed.discussionName);

  // Word diff by default, with counts in words.
  await expect(engineSelect(page)).toHaveValue("word");
  await expect(comparison.locator("[data-compare-counts]")).toContainText(
    "words matched",
  );
  await expect(comparison.locator(".diff-added").first()).toBeVisible();
  await expect(comparison.locator(".diff-removed").first()).toBeVisible();
});

test("each of the five engines shows its view and its counts", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-engines");
  const [first, , json, fourth, otherJson] = seed.answers;
  await openComparison(page, first, fourth);
  const comparison = page.getByRole("region", { name: "Comparison" });
  const counts = comparison.locator("[data-compare-counts]");

  const textEngines = [
    { id: "word", unit: "words matched" },
    { id: "line", unit: "lines matched" },
    { id: "character", unit: "characters matched" },
  ];
  for (const { id, unit } of textEngines) {
    await engineSelect(page).selectOption(id);
    await expect(page).toHaveURL(
      id === "word"
        ? /\/compare\?a=[^&]+&b=[^&]+$/
        : new RegExp(`engine=${id}`),
    );
    await expect(counts).toContainText(unit);
    await expect(counts.locator(".diff-count-green")).toHaveText(/^\+\d+ /);
    await expect(counts.locator(".diff-count-red")).toHaveText(/^−\d+ /);
    // Inline first, then side by side with A and B panels.
    await expect(
      comparison.locator('[data-compare-view="inline"] .diff-added').first(),
    ).toBeVisible();
    await comparison.getByRole("tab", { name: "Side by side" }).click();
    await expect(comparison.locator("[data-compare-panel]")).toHaveCount(2);
    await expect(
      comparison.locator('[data-compare-panel="A"] .diff-added'),
    ).toHaveCount(0);
    await expect(
      comparison.locator('[data-compare-panel="B"] .diff-removed'),
    ).toHaveCount(0);
    await comparison.getByRole("tab", { name: "Inline" }).click();
  }

  // JSON: the two JSON answers, from different notebooks.
  await openComparison(page, json, otherJson, "json");
  await expect(comparison.getByRole("tab")).toHaveCount(0);
  await expect(comparison.locator("[data-compare-finding]")).toHaveCount(3);
  await expect(comparison).toContainText("$.model");
  await expect(comparison.locator(".finding-pill-conflict")).toHaveCount(3);
  await expect(counts).toHaveText("+0 added−0 removed~3 changed1 unchanged");
  await expect(counts.locator(".diff-count-amber")).toHaveText("~3 changed");

  // JSON on text that is not JSON names the side.
  await openComparison(page, first, otherJson, "json");
  await expect(comparison.locator("[data-compare-error]")).toHaveText(
    "Answer A (answer 1) is not valid JSON",
  );

  // Semantic: findings with statements counted.
  await openComparison(page, first, fourth, "semantic");
  await expect(
    comparison.locator("[data-compare-finding]").first(),
  ).toBeVisible();
  await expect(counts).toContainText("statements");
  await expect(comparison).toContainText("NOT an LLM");
});

test("semantic findings: agreement, uncertain and unique pills", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-semantic", [
    SEMANTIC.a,
    SEMANTIC.b,
    TEXT.json,
    TEXT.fourth,
  ]);
  await openComparison(page, seed.answers[0], seed.answers[1], "semantic");
  const comparison = page.getByRole("region", { name: "Comparison" });
  await expect(comparison.locator(".finding-pill-uncertain")).toHaveCount(1);
  await expect(comparison.locator(".finding-pill-agreement")).toHaveCount(1);
  await expect(comparison.locator(".finding-pill-unique")).toHaveCount(2);
});

test("Character diff over 20,000 characters says it is too long; Word diff still runs", async ({
  page,
  context,
}) => {
  const long = (TEXT.first + "\n").repeat(60); // about 11,000 characters
  const longOther = (TEXT.fourth + "\n").repeat(60);
  const seed = await seedCompare(context, "compare-cap", [
    long,
    longOther,
    TEXT.json,
    TEXT.fourth,
  ]);
  expect(long.length + longOther.length).toBeGreaterThan(20_000);
  await openComparison(page, seed.answers[0], seed.answers[1], "character");
  const comparison = page.getByRole("region", { name: "Comparison" });
  await expect(comparison.locator("[data-compare-too-long]")).toHaveText(
    /^These two answers are too long for Character diff: [\d,]+ characters together, and Character diff runs on up to 20,000\. Use Word diff or Line diff\.$/,
  );
  await expect(comparison.locator(".diff-added")).toHaveCount(0);
  await engineSelect(page).selectOption("word");
  await expect(comparison.locator("[data-compare-counts]")).toContainText(
    "words matched",
  );
});

test("another user's answer, a made-up id and a malformed id all show Response not found", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-notfound");
  const madeUp = "00000000-0000-4000-8000-000000000000";
  for (const id of [seed.strangerAnswer, madeUp, "not-an-id"]) {
    await page.goto(`/compare?a=${seed.answers[0]}&b=${id}`);
    await expect(page.locator('[data-compare-not-found="B"]')).toHaveText(
      "Response not found",
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-compare-not-found="A"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Comparison" })).toHaveCount(
      0,
    );
    // Nothing of the other user's answer is shown anywhere.
    await expect(page.locator("body")).not.toContainText("Another user's");
  }
});

test("an answer with no text says there is nothing to compare", async ({
  page,
  context,
}) => {
  const seed = await seedCompare(context, "compare-empty", [
    TEXT.first,
    "",
    TEXT.json,
    TEXT.fourth,
  ]);
  await openComparison(page, seed.answers[0], seed.answers[1]);
  await expect(page.locator("[data-compare-empty-text]")).toHaveText(
    "Answer B (answer 2) has no text, so there is nothing to compare.",
  );
});

// A browser in another time zone than the server, so the dates the
// server renders differ from the browser's.
test.describe("in a browser far from the server's time zone", () => {
  test.use({ timezoneId: "Pacific/Auckland" });

  test("a reload keeps the comparison, the engine included", async ({
    page,
    context,
  }) => {
    const seed = await seedCompare(context, "compare-reload");
    // The server renders dates in its time zone and the browser in the
    // user's: no hydration error may come of it.
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /hydrat/i.test(m.text()))
        problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    await openComparison(page, seed.answers[1], seed.answers[3], "line");
    const counts = page.locator("[data-compare-counts]");
    await expect(counts).toContainText("lines matched");
    const before = await counts.textContent();
    await page.reload();
    await expect(pickerA(page)).toHaveValue(seed.answers[1]);
    await expect(pickerB(page)).toHaveValue(seed.answers[3]);
    await expect(engineSelect(page)).toHaveValue("line");
    await expect(counts).toHaveText(before!);
    expect(problems).toEqual([]);
  });
});

test("signed out, /compare goes to the sign-in page", async ({ page }) => {
  await page.goto("/compare?a=00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/login$/);
});
