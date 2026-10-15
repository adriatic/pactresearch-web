import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";

// Task 94. After a picture is pasted into the prompt box, the cursor is
// right after it and the picture is not selected, so typing straight
// away adds text after the picture instead of replacing it. Runs in
// chromium and webkit-ipad (playwright.config.ts). The pastes are real
// paste events with a real PNG file, uploaded for real; one chromium test
// also uses a real clipboard and Cmd/Ctrl+V.
//
// The user signs up and seeds their own rows with the anon key and their
// own session (RLS), so no service-role key is needed.

const OPEN = "Task 94 paste cursor";

test.setTimeout(90_000);

function localSupabase() {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string };
}

async function signInWithOpenDiscussion(page: Page, context: BrowserContext) {
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
    email: `e2e-task94-${suffix}@example.com`,
    password: "correct horse battery staple 94!",
  });
  if (error || !data.user) throw error ?? new Error("no user");
  const userId = data.user.id;
  const notebookName = `E2E task 94 ${suffix}`;
  const { data: nb, error: nbError } = await client
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName, category: "Dev Test" })
    .select()
    .single();
  if (nbError) throw nbError;
  const { error: dError } = await client
    .from("discussions")
    .insert({ notebook_id: nb.id, user_id: userId, name: OPEN });
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
  await childRow.click();
  await expect(promptBox(page)).toBeVisible({ timeout: 15_000 });
  await promptBox(page).click();
}

function promptBox(page: Page) {
  return page.getByRole("textbox", { name: "Prompt", exact: true });
}

function images(page: Page) {
  return promptBox(page).locator("img");
}

// A real paste event carrying a real PNG file (made on a canvas), as the
// browser sends for Cmd+V with a picture on the clipboard. Waits for the
// upload and the picture to appear.
async function pastePicture(page: Page) {
  const before = await images(page).count();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "teal";
    g.fillRect(0, 0, 40, 30);
    const blob = await new Promise<Blob>((r) =>
      canvas.toBlob((b) => r(b!), "image/png"),
    );
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([blob], "pasted.png", { type: "image/png" }),
    );
    document.querySelector('[contenteditable="true"]')!.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });
  await expect(images(page)).toHaveCount(before + 1, { timeout: 10_000 });
}

// The prompt box as a list: "[picture]" for a picture, the text of each
// line otherwise ("" for an empty line, not counting the editor's own
// trailing empty line).
async function contentShape(page: Page): Promise<string[]> {
  const shape = await promptBox(page).evaluate((el) =>
    Array.from(el.children).map((child) =>
      child.tagName === "IMG" ? "[picture]" : (child.textContent ?? ""),
    ),
  );
  while (shape.length > 1 && shape.at(-1) === "") shape.pop();
  return shape;
}

async function expectNothingSelected(page: Page) {
  await expect(
    promptBox(page).locator(".ProseMirror-selectednode"),
  ).toHaveCount(0);
}

test("a picture pasted into an empty prompt: typing goes after it", async ({
  page,
  context,
}) => {
  await signInWithOpenDiscussion(page, context);
  await pastePicture(page);
  await expectNothingSelected(page);
  await page.keyboard.type("Typed after.");
  await expect(images(page)).toHaveCount(1);
  expect(await contentShape(page)).toEqual(["[picture]", "Typed after."]);
});

test("a picture pasted in the middle of text: it splits the line and typing goes right after it", async ({
  page,
  context,
}) => {
  await signInWithOpenDiscussion(page, context);
  await page.keyboard.type("abcdef");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await pastePicture(page);
  await expectNothingSelected(page);
  await page.keyboard.type("X");
  await expect(images(page)).toHaveCount(1);
  expect(await contentShape(page)).toEqual(["abc", "[picture]", "Xdef"]);
});

test("two pictures pasted one after the other: both stay, in order, and typing goes after the second", async ({
  page,
  context,
}) => {
  await signInWithOpenDiscussion(page, context);
  await page.keyboard.type("Start.");
  await pastePicture(page);
  await pastePicture(page);
  await expectNothingSelected(page);
  await page.keyboard.type("End.");
  await expect(images(page)).toHaveCount(2);
  expect(await contentShape(page)).toEqual([
    "Start.",
    "[picture]",
    "[picture]",
    "End.",
  ]);
});

test("Enter right after a paste adds an empty line after the picture and keeps it", async ({
  page,
  context,
}) => {
  await signInWithOpenDiscussion(page, context);
  await page.keyboard.type("Before.");
  await pastePicture(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Two lines down.");
  await expect(images(page)).toHaveCount(1);
  expect(await contentShape(page)).toEqual([
    "Before.",
    "[picture]",
    "",
    "Two lines down.",
  ]);
});

// As in an ordinary editor: the first Backspace right after a paste
// steps back onto the picture (selects it) without removing it, removing
// only the empty line the cursor was on; a second Backspace removes it.
test("Backspace right after a paste selects the picture; a second Backspace removes it", async ({
  page,
  context,
}) => {
  await signInWithOpenDiscussion(page, context);
  await page.keyboard.type("Before.");
  await pastePicture(page);
  await page.keyboard.press("Backspace");
  await expect(images(page)).toHaveCount(1);
  await expect(
    promptBox(page).locator("img.ProseMirror-selectednode"),
  ).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(images(page)).toHaveCount(0);
  await page.keyboard.type(" More.");
  expect((await contentShape(page)).join("|")).toContain("Before.");
  expect((await contentShape(page)).join("|")).toContain("More.");
});

// The same as the first test, with a real clipboard and a real key press,
// as Nik does it. Chromium only: WebKit in Playwright cannot be given
// clipboard permission.
test("a real Cmd/Ctrl+V of a picture, then typing straight away, keeps the picture", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "clipboard permission is chromium-only",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInWithOpenDiscussion(page, context);
  await page.keyboard.type("Before.");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "purple";
    g.fillRect(0, 0, 40, 30);
    const blob = await new Promise<Blob>((r) =>
      canvas.toBlob((b) => r(b!), "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await page.keyboard.press("ControlOrMeta+V");
  await expect(images(page)).toHaveCount(1, { timeout: 10_000 });
  await page.keyboard.type("After.");
  await expect(images(page)).toHaveCount(1);
  expect(await contentShape(page)).toEqual(["Before.", "[picture]", "After."]);
});
