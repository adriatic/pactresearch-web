import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 85, from Nik's Preview screenshot before he records demos: the
// top-bar buttons stood about 4px apart, the Provider dropdown was white
// among grey buttons (and, in WebKit, 23px tall beside 38px buttons), the
// run-status dot floated alone between the activity text and Export, and
// the composer's box sat right against the discussion header. This
// checks the look at several widths; provider-dropdown-layout.spec.ts
// keeps checking that the dropdown stays next to Model. Runs in chromium
// and webkit-ipad (playwright.config.ts).

test.setTimeout(90_000);

test.beforeEach(async ({ page, context }) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-top-bar-${suffix}@example.com`;
  const password = "top bar layout e2e 85!";
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.user!.id;
  const notebookName = `E2E top bar notebook ${suffix}`;
  const discussionName = `E2E top bar discussion ${suffix}`;
  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  await admin.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  await client.auth.signInWithPassword({ email, password });
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
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
});

type Box = { x: number; y: number; width: number; height: number };

async function headerControls(page: Page) {
  const header = page.locator("header");
  const names = ["New Notebook", "Run", "Import", "Settings", "Account"];
  const boxes: { name: string; box: Box }[] = [];
  for (const name of names) {
    boxes.push({
      name,
      box: (await header
        .getByRole("button", { name, exact: true })
        .boundingBox())!,
    });
  }
  boxes.push({
    name: "Model",
    box: (await header.getByRole("button", { name: "Model" }).boundingBox())!,
  });
  boxes.push({
    name: "Provider",
    box: (await header
      .getByRole("combobox", { name: "Provider" })
      .boundingBox())!,
  });
  return boxes;
}

for (const width of [1512, 1440, 1280, 1080, 800]) {
  test(`at ${width}px wide, the top bar, discussion header and composer are spaced and styled`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const header = page.locator("header");
    const dropdown = header.getByRole("combobox", { name: "Provider" });
    await expect(dropdown).toBeVisible();

    // Every control wholly inside the window, none overlapping, and
    // neighbours on one line at least 8px apart (it was about 4px).
    const controls = await headerControls(page);
    for (const { name, box } of controls) {
      expect(box.x, name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, name).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < controls.length; i++) {
      const a = controls[i - 1].box;
      const b = controls[i].box;
      const sameLine = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 8;
      if (sameLine) {
        expect(
          b.x - (a.x + a.width),
          `${controls[i - 1].name} to ${controls[i].name}`,
        ).toBeGreaterThanOrEqual(8);
      } else {
        // A wrap starts a new line below, never overlapping the last.
        expect(b.y, controls[i].name).toBeGreaterThanOrEqual(a.y + a.height);
      }
    }

    // The dropdown looks like the grey buttons beside it: same
    // background, border colour and height.
    const look = (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          background: s.backgroundColor,
          border: s.borderTopColor,
          height: Math.round(el.getBoundingClientRect().height),
        };
      });
    const model = await header
      .getByRole("button", { name: "Model" })
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          background: s.backgroundColor,
          border: s.borderTopColor,
          height: Math.round(el.getBoundingClientRect().height),
        };
      });
    const select = await look('header select[aria-label="Provider"]');
    expect(select.background).toBe(model.background);
    expect(select.border).toBe(model.border);
    expect(Math.abs(select.height - model.height)).toBeLessThanOrEqual(1);

    // The discussion header: Export at the right end, with the run status
    // dot right beside it rather than floating mid-row.
    const group = page.getByRole("group", { name: "Active discussion" });
    const groupBox = (await group.boundingBox())!;
    const exportBox = (await group
      .getByRole("button", { name: "Export discussion", exact: true })
      .boundingBox())!;
    const statusBox = (await group.getByRole("status").boundingBox())!;
    expect(
      groupBox.x + groupBox.width - (exportBox.x + exportBox.width),
    ).toBeLessThanOrEqual(16);
    expect(exportBox.x - (statusBox.x + statusBox.width)).toBeGreaterThan(0);
    expect(exportBox.x - (statusBox.x + statusBox.width)).toBeLessThan(24);

    // Room above the composer: its box starts at least 10px below the
    // discussion name (it was 4px).
    const nameBottom = await group
      .locator("span")
      .first()
      .evaluate((el) => {
        const b = el.getBoundingClientRect();
        return b.y + b.height;
      });
    const composerTop = await page.getByLabel("Prompt").evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      while (node && getComputedStyle(node).borderTopWidth !== "1px") {
        node = node.parentElement;
      }
      return node!.getBoundingClientRect().y;
    });
    expect(composerTop - nameBottom).toBeGreaterThanOrEqual(10);
  });
}
