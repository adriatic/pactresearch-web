import { test, expect } from "@playwright/test";
import {
  dragFiles,
  expectSummary,
  fixtureText,
  importStatus,
  notebookCount,
  signIn,
} from "./importHelpers";

// Task 79 (desktop, Chromium): several files at once through the Import
// input, drag and drop onto the window, and the newer file chooser
// (showOpenFilePicker) that remembers the last folder.

test.setTimeout(60_000);

const GOOD_A = { name: "a.pact", text: fixtureText("plain-old-minimal.pact") };
const GOOD_B = {
  name: "b.pact",
  text: fixtureText("plain-old-gpt-parent-chain.pact"),
};
const DAMAGED = { name: "damaged.pact", text: fixtureText("truncated.pact") };
const OLDER = {
  name: "older.pact",
  text: fixtureText("signed-pactresearch-net.pact"),
};
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const asInput = (f: { name: string; text: string }) => ({
  name: f.name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(f.text),
});

test("the Import input takes several files; one bad file does not stop the rest", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles([GOOD_A, DAMAGED, GOOD_B].map(asInput));

  await expectSummary(page, "Imported 2 of 3 files.");
  await expectSummary(page, "damaged.pact: The file is damaged or incomplete.");
  expect(await notebookCount(admin, userId)).toBe(2);
  await expect(
    page.getByRole("treeitem", { name: "Fixture old minimal notebook" }),
  ).toBeVisible();
});

test("an older-format file among good ones says what to do", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles([GOOD_A, OLDER].map(asInput));
  await expectSummary(page, "Imported 1 of 2 files.");
  await expectSummary(
    page,
    "older.pact: This file is in an older PACT format. Convert it with the PACT converter first.",
  );
  expect(await notebookCount(admin, userId)).toBe(1);
});

test("dragging a .pact file over the window shows the hint; dropping imports it", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  await dragFiles(page, "dragover", [GOOD_A]);
  await expect(page.locator("[data-pact-drop-overlay]")).toHaveText(
    "Drop .pact files to import",
  );
  await dragFiles(page, "drop", [
    GOOD_A,
    GOOD_B,
    { name: "notes.txt", text: "x" },
  ]);
  await expect(page.locator("[data-pact-drop-overlay]")).toHaveCount(0);
  await expectSummary(page, "Imported 2 of 3 files.");
  await expectSummary(page, "notes.txt: Not a .pact file, so it was left out.");
  expect(await notebookCount(admin, userId)).toBe(2);
});

test("dragging an image shows no hint, and an image dropped on the composer still goes into the prompt", async ({
  page,
  context,
}) => {
  await signIn(page, context, { withDiscussion: true });
  const discussion = page.getByRole("treeitem", {
    name: /E2E drop discussion/,
  });
  await expect(async () => {
    if ((await discussion.count()) === 0) {
      await page
        .getByRole("treeitem", { name: /E2E drop notebook/ })
        .locator("h3")
        .click();
    }
    await expect(discussion).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussion.click();

  const png = Buffer.from(TINY_PNG, "base64").toString("latin1");
  await dragFiles(page, "dragover", [
    { name: "photo.png", text: png, mime: "image/png" },
  ]);
  await expect(page.locator("[data-pact-drop-overlay]")).toHaveCount(0);

  // A real drop of a real image File onto the editor.
  await page.evaluate((base64) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    const editor = document.querySelector('[contenteditable="true"]')!;
    const r = editor.getBoundingClientRect();
    editor.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.left + 5,
        clientY: r.top + 5,
      }),
    );
  }, TINY_PNG);
  await expect(page.locator('img[alt="dropped.png"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(importStatus(page)).toHaveCount(0);
});

test("with the newer file chooser, Import uses it (not the plain input)", async ({
  page,
  context,
}) => {
  await page.addInitScript((text) => {
    (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls = [];
    (
      window as unknown as { showOpenFilePicker: (o: unknown) => unknown }
    ).showOpenFilePicker = async (options: unknown) => {
      (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls.push(
        options,
      );
      return [{ getFile: async () => new File([text], "picked.pact") }];
    };
  }, GOOD_A.text);
  const { admin, userId } = await signIn(page, context);
  let plainChooserOpened = false;
  page.on("filechooser", () => {
    plainChooserOpened = true;
  });

  await page.getByRole("button", { name: "Import" }).click();
  await expectSummary(page, "Imported 1 file.");
  expect(await notebookCount(admin, userId)).toBe(1);
  expect(plainChooserOpened).toBe(false);
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __pickerCalls: { id: string }[] }).__pickerCalls,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].id).toBe("pact-import");
});

test("cancelling the newer file chooser shows nothing", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    (
      window as unknown as { showOpenFilePicker: () => unknown }
    ).showOpenFilePicker = async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    };
  });
  const { admin, userId } = await signIn(page, context);
  let plainChooserOpened = false;
  page.on("filechooser", () => {
    plainChooserOpened = true;
  });
  await page.getByRole("button", { name: "Import" }).click();
  await page.waitForTimeout(1_000);
  await expect(importStatus(page)).toHaveCount(0);
  expect(plainChooserOpened).toBe(false);
  expect(await notebookCount(admin, userId)).toBe(0);
});
