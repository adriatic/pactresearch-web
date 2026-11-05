import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseRowAction } from "./rowMenuActions";
import {
  chooseTheme,
  contrastSweep,
  MIN_CONTRAST,
  openSeededDiscussion,
  seedSignedIn,
  type ContrastItem,
} from "./themeHelpers";

// Task D11. A contrast sweep in both themes: every piece of text the
// browser draws on the main screen (Top bar, Explorer with a selected
// row, a run-time line, the running badge and an import summary, a
// response cell, the composer with its placeholder and status dot), in
// each dialog and in the row menu, measured against the background it
// actually sits on.
//
// Dark: every item reaches 4.5:1, no exceptions.
//
// Light: the light values were left exactly as they were (the brief for
// D11), and five colors were already below 4.5:1 before D11 (four variables
// and Tailwind's own placeholder color). They are listed
// here by color so that any NEW light failure still fails this spec;
// changing them is a separate decision (see the D11 report).
const LIGHT_KNOWN_BELOW: { fg: string; bg?: string; why: string }[] = [
  {
    fg: "#888888",
    why: "--text-faint #888: placeholder, Thinking, No discussions yet (3.5:1)",
  },
  {
    fg: "#999999",
    why: "--text-disabled #999: a switched-off line in Choose… (2.8:1)",
  },
  {
    fg: "#ffffff",
    bg: "#d97706",
    why: "--badge-text on --badge-bg: the Running badge (3.2:1)",
  },
  {
    fg: "#8b8b8b",
    why: "Tailwind's own field placeholder, half the text color (not a D10 variable): 3.4:1",
  },
  {
    fg: "#4ec94e",
    why: "--status-idle #4ec94e: the idle dot and the last run time beside it (2.2:1)",
  },
];

test.setTimeout(180_000);

function knownLight(item: ContrastItem) {
  return LIGHT_KNOWN_BELOW.some(
    (k) => k.fg === item.fg && (!k.bg || k.bg === item.bg),
  );
}

async function sweepInto(
  areas: Record<string, ContrastItem[]>,
  name: string,
  scope: Locator,
) {
  await expect(scope).toBeVisible();
  const items = await contrastSweep(scope);
  expect(items.length, `${name}: something to measure`).toBeGreaterThan(0);
  areas[name] = items;
}

async function sweepApp(page: Page) {
  const areas: Record<string, ContrastItem[]> = {};
  const header = page.locator("header");

  // Main screen. The status dot is a shape, not text: mark it so the
  // sweep measures it against what is behind it.
  await page
    .locator('[role="status"] span[title]')
    .first()
    .evaluate((el) => el.setAttribute("data-contrast-mark", "status dot"));
  await sweepInto(areas, "Main screen", page.locator("body"));

  // Row menu.
  const notebookRow = page
    .getByRole("treeitem", { name: /E2E theme-sweep notebook/ })
    .first();
  await notebookRow
    .getByRole("button", { name: /^Actions for / })
    .first()
    .click();
  await sweepInto(areas, "Row menu", page.getByRole("menu").first());
  await page.keyboard.press("Escape");

  // Dialogs from the Top bar.
  async function dialog(
    name: string,
    open: () => Promise<void>,
    scope: Locator,
    close: () => Promise<void>,
  ) {
    await open();
    await sweepInto(areas, name, scope);
    await close();
    await expect(scope).toBeHidden();
  }
  const cancel = (scope: Locator) => () =>
    scope.getByRole("button", { name: "Cancel" }).last().click();

  const newNotebook = page.getByRole("dialog", { name: "New notebook" });
  await dialog(
    "New notebook",
    () => header.getByRole("button", { name: "New Notebook" }).click(),
    newNotebook,
    cancel(newNotebook),
  );

  const settings = page.locator("section", {
    has: page.getByRole("heading", { name: "Notebook settings" }),
  });
  await dialog(
    "Notebook settings",
    () => header.getByRole("button", { name: "Settings" }).click(),
    settings,
    cancel(settings),
  );

  const account = page.getByRole("dialog", { name: "Account" });
  await header.getByRole("button", { name: "Account" }).click();
  await sweepInto(areas, "Account (Profile)", account);
  await account.getByRole("tab", { name: "Keys" }).click();
  await account.getByText("ChatGPT (optional)").click();
  await sweepInto(areas, "Account (Keys)", account);
  await account.getByRole("button", { name: "Close" }).last().click();
  await expect(account).toBeHidden();

  const model = page.getByRole("dialog", { name: "Model tier" });
  await dialog(
    "Model tier",
    () => header.getByRole("button", { name: "Model" }).click(),
    model,
    cancel(model),
  );

  const context = page.getByRole("dialog", {
    name: "What to send with this question",
  });
  await dialog(
    "Choose… (context)",
    () => page.getByRole("button", { name: "Choose…" }).click(),
    context,
    cancel(context),
  );

  // Dialogs from the row menu.
  const nbName = (await notebookRow.locator("h3").first().innerText()).trim();
  for (const [action, label] of [
    ["Add discussion", "Add discussion"],
    ["Rename", "Rename notebook"],
    ["Delete notebook", "Delete notebook"],
  ] as const) {
    const d = page.getByRole("dialog", { name: label });
    await dialog(
      label,
      () => chooseRowAction(notebookRow, nbName, action),
      d,
      cancel(d),
    );
  }

  const report = page.getByRole("dialog", { name: "Diagnostic capture" });
  await dialog(
    "Report a problem",
    () => page.getByRole("button", { name: "Report a problem" }).click(),
    report,
    () => report.getByRole("button", { name: "Close" }).click(),
  );

  return areas;
}

for (const theme of ["light", "dark"] as const) {
  test(`contrast sweep, ${theme} theme: every text and mark reaches 4.5:1${theme === "light" ? " (known light exceptions listed)" : ""}`, async ({
    page,
    context,
  }, testInfo) => {
    const seeded = await seedSignedIn(context, {
      tag: "theme-sweep",
      totalTimeMs: 134_000,
    });
    const { admin, userId, discussionId } = seeded;
    // A run-time line under the notebook, and ten answers so the
    // composer shows its context line with Choose….
    await admin.from("execution_timings").insert({
      user_id: userId,
      discussion_id: discussionId,
      resolved_model: "claude-sonnet-5",
      max_tokens: 1024,
      total_ms: 134_000,
    });
    await admin.from("responses").insert(
      Array.from({ length: 10 }, (_, i) => ({
        discussion_id: discussionId,
        user_id: userId,
        prompt_text: `Question ${i + 1}`,
        response: `Answer ${i + 1}, with **bold** text and a [link](https://example.com).`,
        model: "claude-sonnet-5",
        resolved_model: "claude-sonnet-5",
        created_at: new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString(),
      })),
    );
    // A second notebook with nothing in it: "No discussions yet."
    await admin
      .from("notebooks")
      .insert({ user_id: userId, name: "E2E theme-sweep empty" });
    // The running badge: the Explorer asks the server which discussion
    // holds the run lock. Here the answer is a second discussion, so the
    // open one (and its composer) stays idle.
    const { data: busy } = await admin
      .from("discussions")
      .insert({
        notebook_id: seeded.notebookId,
        user_id: userId,
        name: "E2E theme-sweep busy",
      })
      .select()
      .single();
    await page.route("**/api/execution-locks", (route) =>
      route.fulfill({ json: { discussionId: busy!.id } }),
    );

    await chooseTheme(context, theme);
    await openSeededDiscussion(page, seeded);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page
      .getByRole("treeitem", { name: "E2E theme-sweep empty", exact: true })
      .locator("h3")
      .click();
    await expect(page.getByText("No discussions yet.")).toBeVisible();
    await expect(page.getByLabel("Currently running")).toBeVisible();
    // An import summary: a file that is not a .pact export, so the
    // headline is the red one.
    await page.locator('input[type="file"][accept=".pact"]').setInputFiles({
      name: "not-a-pact.pact",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("this is not a pact file"),
    });
    await expect(page.locator("[data-import-status]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Answer 10,")).toBeVisible();
    // The context line under the composer (ten turns bring it up).
    await expect(page.locator("[data-context-summary]")).toBeVisible({
      timeout: 15_000,
    });
    // An empty composer, so its placeholder is drawn. (It keeps the last
    // prompt otherwise.)
    await page.getByLabel("Prompt").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".tiptap p.is-editor-empty")).toHaveCount(1);

    const areas = await sweepApp(page);
    await testInfo.attach(`contrast-${theme}.json`, {
      body: JSON.stringify(areas, null, 2),
      contentType: "application/json",
    });
    // As modal-field-styling does with MODAL_SHOTS_DIR: somewhere stable
    // to read every measured item while working on the colors.
    const outDir = process.env.THEME_SWEEP_DIR;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, `contrast-${theme}.json`),
        JSON.stringify(areas, null, 2),
      );
    }

    // Coverage: the sweep really met the things the brief names.
    const main = areas["Main screen"].map((i) => i.text);
    for (const expected of [
      "New Notebook", // Top bar
      seeded.discussionName, // selected row
      "2m 14s", // run-time line
      "● Running", // running badge
      "No discussions yet.",
      "Claude · claude-sonnet-5", // response cell label
      "Answer 10, with", // response text
      "status dot",
      "With this question", // the composer's context line
      "The file could not be imported", // import summary
    ]) {
      expect(
        main.some((t) => t.includes(expected)),
        `main screen sweep includes "${expected}"`,
      ).toBe(true);
    }
    expect(
      areas["Main screen"].some((i) => i.kind === "placeholder"),
      "the composer placeholder was measured",
    ).toBe(true);

    const below = Object.entries(areas).flatMap(([area, items]) =>
      items.filter((i) => i.ratio < MIN_CONTRAST).map((i) => ({ area, ...i })),
    );
    const unexpected =
      theme === "dark" ? below : below.filter((i) => !knownLight(i));
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });
}
