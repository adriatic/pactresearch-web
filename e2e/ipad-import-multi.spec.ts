import { test, expect } from "@playwright/test";
import {
  dragFiles,
  expectSummary,
  fixtureText,
  notebookCount,
  signIn,
} from "./importHelpers";

// Task 79 on the iPad profile (WebKit, touch). Safari has no
// showOpenFilePicker, so Import must still open the plain file chooser --
// now allowing several files -- and the drop overlay must never appear on
// a touch device.

test.setTimeout(60_000);

test("Import opens the plain chooser, with several files allowed", async ({
  page,
  context,
}) => {
  const { admin, userId } = await signIn(page, context);
  expect(
    await page.evaluate(
      () =>
        typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker,
    ),
  ).toBe("undefined");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import" }).tap();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    {
      name: "a.pact",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixtureText("plain-old-minimal.pact")),
    },
    {
      name: "b.pact",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixtureText("plain-old-gpt-parent-chain.pact")),
    },
  ]);
  await expectSummary(page, "Imported 2 files.");
  expect(await notebookCount(admin, userId)).toBe(2);
});

test("no drop overlay on a touch device", async ({ page, context }) => {
  await signIn(page, context);
  expect(
    await page.evaluate(
      () => window.matchMedia("(hover: hover) and (pointer: fine)").matches,
    ),
  ).toBe(false);
  await dragFiles(page, "dragover", [
    { name: "a.pact", text: fixtureText("plain-old-minimal.pact") },
  ]);
  await page.waitForTimeout(300);
  await expect(page.locator("[data-pact-drop-overlay]")).toHaveCount(0);
});
