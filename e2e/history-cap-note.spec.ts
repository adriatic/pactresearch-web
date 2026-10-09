import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 71 Stage 1, the whole chain: browser -> /api/execute -> the model
// (a local stand-in, see anthropicUrlFor in app/api/execute) -> browser.
// Nik's Preview test (2026-10-09) showed the cap working but the grey
// note never appearing; the parts had been tested only separately.
//
// The stand-in answers with the code words it was actually sent, so the
// answer on screen is what the model could see.

// One stand-in per test worker (port 54390 + worker number, carried in
// the stored key), so the Chrome and iPad runs can overlap.
let MOCK_KEY = "";
const CODES = ["AMBER", "BIRCH", "CEDAR", "DELTA", "EMBER", "FALCON", "GARNET"];
// The ten code words of the test file Nik imports (history-cap-test-2).
const FILE_CODES = [
  "AMBER",
  "BIRCH",
  "CEDAR",
  "DELTA",
  "EMBER",
  "FALCON",
  "GARNET",
  "HARBOR",
  "IVORY",
  "JUNIPER",
];

test.describe.configure({ mode: "serial" });

let server: Server;
const received: { role: string; content: unknown }[][] = [];

test.beforeAll(async ({}, workerInfo) => {
  const port = 54390 + workerInfo.workerIndex;
  MOCK_KEY = `sk-ant-e2e-mock-${port}`;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        messages: { role: string; content: unknown }[];
      };
      received.push(body.messages);
      const seen = FILE_CODES.filter(
        (c) => raw.includes(`CODE ${c}`) || raw.includes(`code word: ${c}`),
      );
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model: "claude-e2e-mock",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: `I can see: ${seen.join(", ")}` },
        },
        { type: "message_stop" },
      ];
      // Streamed the way the real model streams: event by event, over a
      // second or two, with the event types it really sends.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = `I can see: ${seen.join(", ")}`;
      const stream = [
        events[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "ping" },
        ...text.match(/.{1,6}/g)!.map((t) => ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: t },
        })),
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ];
      let next = 0;
      const tick = setInterval(() => {
        if (next >= stream.length) {
          clearInterval(tick);
          res.end();
          return;
        }
        const e = stream[next++];
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }, 80);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function status(): {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
} {
  return JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
}

async function seedLongDiscussion(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = status();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-cap-note-${suffix}@example.com`;
  const password = "correct horse battery staple 71!";
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.user!.id;
  const notebookName = `E2E cap note ${suffix}`;
  const discussionName = `E2E long discussion ${suffix}`;
  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  const { data: discussion } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  // Seven turns of about 26,700 estimated tokens each: with max_tokens at
  // 40,000 the newest five fit, and the two oldest are left out.
  await admin.from("responses").insert(
    CODES.map((code, i) => ({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: `CODE ${code} ` + "p".repeat(40_000),
      response: `Noted ${i + 1}. ` + "r".repeat(40_000),
      model: "m",
      resolved_model: "claude-e2e-mock",
      created_at: new Date(Date.UTC(2026, 8, 4, 10, i)).toISOString(),
    })),
  );

  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (all) =>
        all.forEach(({ name, value }) => {
          const existing = jar.find((c) => c.name === name);
          if (existing) existing.value = value;
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
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });

  // The key, stored the way Nik stores his: Account -> Keys -> Save.
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const account = page.getByRole("dialog", { name: "Account" });
  await account.getByRole("tab", { name: "Keys" }).click();
  await account.getByLabel("Anthropic API key:").fill(MOCK_KEY);
  await account.getByRole("button", { name: "Save" }).click();
  await expect(account.getByText("API key saved.")).toBeVisible();
  await account.getByRole("button", { name: "Close" }).click();

  const notebookRow = page.getByRole("treeitem", { name: notebookName });
  const discussionRow = page.getByRole("treeitem", { name: discussionName });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();
  await expect(page.getByText(/^Noted 7\./)).toBeVisible({ timeout: 15_000 });
  return { admin, discussionId: discussion!.id as string };
}

async function ask(page: Page, question: string) {
  // As in Nik's steps: Continue empties the prompt box first.
  await page.getByRole("button", { name: "Continue" }).last().click();
  await page.getByLabel("Prompt").fill(question);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/execute"), {
      timeout: 30_000,
    }),
    page.getByRole("button", { name: "Run", exact: true }).click(),
  ]);
}

const NOTE =
  "To fit the model's size limit, this answer did not see the 2 oldest turns of this discussion. They are still saved here and in exports.";

test.setTimeout(90_000);

test("the grey note appears under the answer when the oldest turns were left out", async ({
  page,
  context,
}) => {
  await seedLongDiscussion(page, context);
  await ask(page, "List every code word you can find.");

  const answer = page.getByText(/^I can see: /);
  await expect(answer).toHaveText(
    "I can see: CEDAR, DELTA, EMBER, FALCON, GARNET",
  );
  const note = page.locator("[data-history-left-out]");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText(NOTE);
  await expect(note).toBeVisible();
  // What the model was sent: five turns and the question.
  expect(received.at(-1)).toHaveLength(11);

  // It survives a reload (remembered in this browser, lib/leftOutMemory).
  await page.reload();
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await expect(page.getByText(/^I can see: /)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-history-left-out]")).toHaveText(NOTE);
});

test("Nik's path: import the test file, ask twice, and the note is there both times", async ({
  page,
  context,
}) => {
  // A user with no data yet, signed in, with the stand-in key stored.
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = status();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const email = `e2e-cap-import-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "correct horse battery staple 71!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (all) =>
        all.forEach(({ name, value }) => {
          const existing = jar.find((c) => c.name === name);
          if (existing) existing.value = value;
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
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));

  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const account = page.getByRole("dialog", { name: "Account" });
  await account.getByRole("tab", { name: "Keys" }).click();
  await account.getByLabel("Anthropic API key:").fill(MOCK_KEY);
  await account.getByRole("button", { name: "Save" }).click();
  await expect(account.getByText("API key saved.")).toBeVisible();
  await account.getByRole("button", { name: "Close" }).click();

  // The very file Nik imports.
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles("e2e/fixtures/history-cap-test-2.pact");
  await expect(page.getByText("Imported 1 file.")).toBeVisible({
    timeout: 30_000,
  });
  const notebookRow = page.getByRole("treeitem", {
    name: "History cap test 2",
  });
  const discussionRow = page.getByRole("treeitem", { name: "Ten long turns" });
  await expect(async () => {
    if ((await discussionRow.count()) === 0) {
      await notebookRow.locator("h3").click();
    }
    await expect(discussionRow).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await discussionRow.click();
  await expect(page.getByText(/code word for turn 10 is JUNIPER/)).toBeVisible({
    timeout: 20_000,
  });

  for (const run of [1, 2]) {
    await ask(
      page,
      "List every code word you can find in this conversation, in order. Do not guess.",
    );
    const answers = page.getByText(/^I can see: /);
    await expect(answers).toHaveCount(run);
    const notes = page.locator("[data-history-left-out]");
    await expect(notes).toHaveCount(run);
    await expect(notes.nth(run - 1)).toBeVisible();
    await expect(notes.nth(run - 1)).toContainText(
      "To fit the model's size limit, this answer did not see the",
    );
  }
  // The first answer saw only the newest six (max_tokens 40,000 locally:
  // four left out), and said so.
  await expect(page.getByText(/^I can see: /).first()).toHaveText(
    "I can see: EMBER, FALCON, GARNET, HARBOR, IVORY, JUNIPER",
  );
  await expect(page.locator("[data-history-left-out]").first()).toHaveText(
    "To fit the model's size limit, this answer did not see the 4 oldest turns of this discussion. They are still saved here and in exports.",
  );
  // The line a "Report a problem" capture carries -- checked in the
  // capture itself, the file Nik would send.
  expect(
    consoleLines.find((l) =>
      l.startsWith("[history] turns sent 6, left out 4"),
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await expect(page.getByLabel("Diagnostic capture JSON")).toContainText(
    "[history] turns sent 6, left out 4, budget",
  );
});
