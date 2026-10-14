import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 93. An unsent prompt offered back after its discussion was deleted
// in another tab: each picture is "[picture N]" in order, in "Show it" and
// on the clipboard, with one sentence saying the pictures cannot be
// recovered. Without pictures, nothing changes. Runs in chromium and
// webkit-ipad (playwright.config.ts); the clipboard is read in chromium
// only, as in stale-work-area.spec.ts.
//
// The user signs up and seeds their own rows with the anon key and their
// own session (RLS), so no service-role key is needed.

const DISCUSSION_GONE = "This discussion was deleted in another tab or window.";
const OPEN = "Task 93 unsent prompt";

test.setTimeout(90_000);

// Tab switches sent by hand, as in stale-work-area.spec.ts.
async function leavePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function returnToPage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

function localSupabase() {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
}

type Part = string | { picture: true };

// Text parts become paragraphs, pictures become image nodes, in order.
// The pictures' files do not exist: only the draft's shape matters here.
function draftDoc(userId: string, parts: Part[]) {
  return {
    type: "doc",
    content: parts.map((part, i) =>
      typeof part === "string"
        ? { type: "paragraph", content: [{ type: "text", text: part }] }
        : {
            type: "image",
            attrs: {
              src: `/api/prompt-images/${userId}/x/${i}.png`,
              alt: null,
            },
          },
    ),
  };
}

async function seedAndSignIn(
  page: Page,
  context: BrowserContext,
  draft: Part[] | null,
) {
  const { API_URL, ANON_KEY } = localSupabase();
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (all) =>
        all.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await client.auth.signUp({
    email: `e2e-task93-${suffix}@example.com`,
    password: "correct horse battery staple 93!",
  });
  if (error || !data.user) throw error ?? new Error("no user");
  const userId = data.user.id;
  const notebookName = `E2E task 93 ${suffix}`;
  const { data: nb, error: nbError } = await client
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  if (nbError) throw nbError;
  const { error: dError } = await client.from("discussions").insert({
    notebook_id: nb.id,
    user_id: userId,
    name: OPEN,
    draft_content: draft ? draftDoc(userId, draft) : null,
  });
  if (dError) throw dError;
  await context.addCookies(
    jar.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  return { notebookName };
}

async function expandNotebook(page: Page, notebookName: string) {
  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const childRow = page.getByRole("treeitem", { name: OPEN, exact: true });
  await expect(notebookRow).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    if ((await childRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(childRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return childRow;
}

function promptBox(page: Page) {
  return page.getByRole("textbox", { name: "Prompt", exact: true });
}

async function deleteInOtherTabAndReturn(
  page: Page,
  context: BrowserContext,
  notebookName: string,
) {
  await leavePage(page);
  const other = await context.newPage();
  await other.goto("/");
  const row = await expandNotebook(other, notebookName);
  await chooseRowAction(row, OPEN, "Delete discussion");
  await other
    .getByRole("dialog", { name: "Delete discussion" })
    .getByRole("button", { name: "Delete discussion" })
    .click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await other.close();
  await returnToPage(page);
  await expect(page.getByText(DISCUSSION_GONE)).toBeVisible({
    timeout: 15_000,
  });
}

async function expectRecovered(
  page: Page,
  context: BrowserContext,
  browserName: string,
  expectedText: string,
  expectedSentence: string | null,
) {
  if (expectedSentence) {
    await expect(page.locator("[data-unsent-pictures]")).toHaveText(
      expectedSentence,
    );
  } else {
    await expect(page.locator("[data-unsent-pictures]")).toHaveCount(0);
    await expect(page.getByText(/cannot be recovered/)).toHaveCount(0);
  }
  await page.getByText("Show it").click();
  await expect(page.locator("[data-unsent-prompt] pre")).toHaveText(
    expectedText,
  );
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy your unsent prompt" }).click();
    await expect(page.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      expectedText,
    );
  }
}

const cases: {
  name: string;
  draft: Part[];
  text: string;
  sentence: string | null;
}[] = [
  {
    name: "no picture: the text as before, and no sentence",
    draft: ["First text.", "Second text."],
    text: "First text.\n\nSecond text.",
    sentence: null,
  },
  {
    name: "one picture",
    draft: ["Before.", { picture: true }, "After."],
    text: "Before.\n\n[picture 1]\n\nAfter.",
    sentence:
      "Your picture cannot be recovered; [picture 1] shows where it was.",
  },
  {
    name: "two pictures mixed with text",
    draft: ["One.", { picture: true }, "Two.", { picture: true }, "Three."],
    text: "One.\n\n[picture 1]\n\nTwo.\n\n[picture 2]\n\nThree.",
    sentence:
      "Your 2 pictures cannot be recovered; [picture 1] and [picture 2] show where they were.",
  },
  {
    name: "three or more pictures mixed with text",
    draft: [
      { picture: true },
      "One.",
      { picture: true },
      { picture: true },
      "Two.",
      { picture: true },
      "Three.",
    ],
    text: "[picture 1]\n\nOne.\n\n[picture 2]\n\n[picture 3]\n\nTwo.\n\n[picture 4]\n\nThree.",
    sentence:
      "Your 4 pictures cannot be recovered; [picture 1] to [picture 4] show where they were.",
  },
];

for (const c of cases) {
  test(`unsent prompt after a delete in another tab, ${c.name}`, async ({
    page,
    context,
    browserName,
  }) => {
    const { notebookName } = await seedAndSignIn(page, context, c.draft);
    await (await expandNotebook(page, notebookName)).click();
    await expect(promptBox(page)).toContainText(
      c.draft.find((part) => typeof part === "string") as string,
      { timeout: 15_000 },
    );
    await expect(promptBox(page).locator("img")).toHaveCount(
      c.draft.filter((part) => typeof part !== "string").length,
    );
    await deleteInOtherTabAndReturn(page, context, notebookName);
    await expectRecovered(page, context, browserName, c.text, c.sentence);
  });
}

// The same with pictures really pasted (uploaded) rather than seeded.
test("pasted pictures are numbered in order in the recovered prompt", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the paste is checked in chromium");
  const { notebookName } = await seedAndSignIn(page, context, null);
  await (await expandNotebook(page, notebookName)).click();
  await expect(promptBox(page)).toBeVisible({ timeout: 15_000 });
  await promptBox(page).click();

  // A canvas-made PNG in a real DataTransfer, pasted as a file.
  async function pastePicture(color: string) {
    const before = await promptBox(page).locator("img").count();
    await page.evaluate(async (fill) => {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      const g = canvas.getContext("2d")!;
      g.fillStyle = fill;
      g.fillRect(0, 0, 40, 30);
      const blob = await new Promise<Blob>((r) =>
        canvas.toBlob((b) => r(b!), "image/png"),
      );
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([blob], `${fill}.png`, { type: "image/png" }),
      );
      document.querySelector('[contenteditable="true"]')!.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    }, color);
    await expect(promptBox(page).locator("img")).toHaveCount(before + 1, {
      timeout: 10_000,
    });
    // The pasted picture is left selected; step past it before typing.
    await page.keyboard.press("ArrowRight");
  }

  await page.keyboard.type("First text.");
  await pastePicture("red");
  await page.keyboard.type("Second text.");
  await pastePicture("blue");
  await page.keyboard.type("Third text.");
  await expect(promptBox(page).locator("img")).toHaveCount(2);

  await deleteInOtherTabAndReturn(page, context, notebookName);
  await expectRecovered(
    page,
    context,
    browserName,
    "First text.\n\n[picture 1]\n\nSecond text.\n\n[picture 2]\n\nThird text.",
    "Your 2 pictures cannot be recovered; [picture 1] and [picture 2] show where they were.",
  );
});
