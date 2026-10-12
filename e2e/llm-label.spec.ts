import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chooseRowAction } from "./rowMenuActions";

// Task 86. Every response cell says which service and model produced it,
// as "Claude · claude-sonnet-5" or "ChatGPT · gpt-6.1-sol", from what the
// row already stores (model, resolved_model). Old rows with no model name
// show the service alone; a row with nothing but the old default is
// Claude. The label belongs to the cell: switching Provider afterwards
// leaves earlier cells as they were.

let anthropicServer: Server;
let openaiServer: Server;
let ANTHROPIC_KEY = "";
let OPENAI_KEY = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

function sse(res: import("node:http").ServerResponse, events: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

test.beforeAll(async ({}, workerInfo) => {
  // Ports of their own, clear of the other specs' stand-ins.
  const anthropicPort = 54450 + workerInfo.workerIndex;
  const openaiPort = 54470 + workerInfo.workerIndex;
  ANTHROPIC_KEY = `sk-ant-e2e-mock-${anthropicPort}`;
  OPENAI_KEY = `sk-e2e-mock-openai-${openaiPort}`;
  anthropicServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Claude answered." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ];
      for (const e of events)
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  openaiServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const model = "gpt-6.1-sol";
      sse(res, [
        {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
        },
        {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { content: "ChatGPT answered." } }],
        },
        {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) =>
    anthropicServer.listen(anthropicPort, "127.0.0.1", r),
  );
  await new Promise<void>((r) =>
    openaiServer.listen(openaiPort, "127.0.0.1", r),
  );
});

test.afterAll(async () => {
  await new Promise((r) => anthropicServer.close(r));
  await new Promise((r) => openaiServer.close(r));
});

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-llm-label-${suffix}@example.com`;
  const password = "llm label e2e 86!";
  const { data: created } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.user!.id;
  const notebookName = `E2E llm label notebook ${suffix}`;
  const discussionName = `E2E llm label discussion ${suffix}`;
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
  return {
    admin,
    userId,
    discussionId: discussion!.id as string,
    notebookName,
    discussionName,
  };
}

async function setExpanded(page: Page, notebookName: string, open: boolean) {
  const row = page.getByRole("treeitem", { name: notebookName, exact: true });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const want = open ? "true" : "false";
  if ((await row.getAttribute("aria-expanded")) !== want) {
    await row.locator("h3").click();
  }
  await expect(row).toHaveAttribute("aria-expanded", want);
}

// Opens the discussion inside one notebook. `collapse` closes another
// notebook first: an imported copy has a discussion of the same name.
async function openDiscussion(
  page: Page,
  notebookName: string,
  discussionName: string,
  collapse?: string,
) {
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  if (collapse) await setExpanded(page, collapse, false);
  await setExpanded(page, notebookName, true);
  const discussionRow = page.getByRole("treeitem", {
    name: discussionName,
    exact: true,
  });
  await expect(discussionRow).toHaveCount(1, { timeout: 15_000 });
  await discussionRow.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
}

const labels = (page: Page) =>
  page.locator("main [data-llm-label]").allTextContents();

const SEEDED_LABELS = [
  "Claude · claude-sonnet-5",
  "ChatGPT · gpt-6.1-sol",
  "Claude · claude-haiku-4-5-20251001",
  "Claude",
  "ChatGPT",
];

test("stored responses: each cell shows its own service and model, after a reload, and after export and import", async ({
  page,
  context,
}) => {
  const { admin, userId, discussionId, notebookName, discussionName } =
    await seed(page, context);
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 9, 11, 9, minute)).toISOString();
  const row = (
    minute: number,
    model: string,
    resolved_model: string | null,
  ) => ({
    discussion_id: discussionId,
    user_id: userId,
    prompt_text: `question ${minute}`,
    response: `answer ${minute}`,
    model,
    resolved_model,
    created_at: at(minute),
  });
  await admin.from("responses").insert([
    // A Claude run since Task 81.
    row(1, "claude-sonnet-5", "claude-sonnet-5"),
    // A ChatGPT run.
    row(2, "gpt-6.1-sol", "gpt-6.1-sol"),
    // Before Task 81: the model that answered was a dated one.
    row(3, "claude-haiku-4-5", "claude-haiku-4-5-20251001"),
    // An old row: only the column's default, nothing resolved.
    row(4, "claude", null),
    // An older PACT app's ChatGPT cell, imported: "gpt" and nothing more.
    row(5, "gpt", null),
  ]);

  await openDiscussion(page, notebookName, discussionName);
  await expect(page.getByText("answer 5")).toBeVisible();
  expect(await labels(page)).toEqual(SEEDED_LABELS);
  // Quiet: small and grey.
  const look = await page
    .locator("main [data-llm-label]")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(look).toBe("rgb(102, 102, 102)");

  // A reload reads the same labels back from the server.
  await page.reload();
  await openDiscussion(page, notebookName, discussionName);
  await expect(page.getByText("answer 5")).toBeVisible();
  expect(await labels(page)).toEqual(SEEDED_LABELS);

  // Export the notebook to a .pact file, import it back as a copy, and
  // open the copy: same labels.
  const notebookRow = page.getByRole("treeitem", {
    name: notebookName,
    exact: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    chooseRowAction(notebookRow, notebookName, "Export"),
  ]);
  await page
    .locator('input[type="file"][accept=".pact"]')
    .setInputFiles((await download.path())!);
  await expect(
    page.getByRole("treeitem", { name: `${notebookName} 1` }),
  ).toHaveCount(1, { timeout: 15_000 });
  await openDiscussion(page, `${notebookName} 1`, discussionName, notebookName);
  await expect(page.getByText("answer 5")).toBeVisible();
  expect(await labels(page)).toEqual(SEEDED_LABELS);
});

test("new runs: a Claude answer and a ChatGPT answer each keep their own label after the Provider changes", async ({
  page,
  context,
}) => {
  const { notebookName, discussionName } = await seed(page, context);
  await openDiscussion(page, notebookName, discussionName);

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();
  await dialog.getByLabel("Anthropic API key:").fill(ANTHROPIC_KEY);
  await dialog.getByRole("button", { name: "Save" }).first().click();
  await expect(dialog.getByText("API key saved.")).toBeVisible();
  await dialog.getByText("ChatGPT (optional)").click();
  const openai = dialog.getByRole("group", { name: "OpenAI key" });
  await openai.getByLabel("OpenAI API key:").fill(OPENAI_KEY);
  await openai.getByRole("button", { name: "Save" }).click();
  await expect(openai.getByText("API key saved.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  const provider = page
    .locator("header")
    .getByRole("combobox", { name: "Provider" });
  const runButton = page
    .locator("header")
    .getByRole("button", { name: "Run", exact: true });
  async function run(text: string, answer: string) {
    await page.getByLabel("Prompt").fill(text);
    await expect(runButton).toBeEnabled();
    await runButton.click();
    await expect(page.getByText(answer).last()).toBeVisible({
      timeout: 20_000,
    });
    await expect(runButton).toHaveText("Run", { timeout: 20_000 });
  }

  await expect(provider).toHaveValue("anthropic");
  await run("first, on Claude", "Claude answered.");
  await expect(page.locator("main [data-llm-label]")).toHaveText([
    "Claude · claude-sonnet-5",
  ]);

  await provider.selectOption("openai");
  await expect(provider).toBeEnabled();
  // Switching Provider does not relabel the answer already given.
  await expect(page.locator("main [data-llm-label]")).toHaveText([
    "Claude · claude-sonnet-5",
  ]);
  await run("second, on ChatGPT", "ChatGPT answered.");
  await expect(page.locator("main [data-llm-label]")).toHaveText([
    "Claude · claude-sonnet-5",
    "ChatGPT · gpt-6.1-sol",
  ]);

  // Back to Claude, and after a reload: both cells as they were.
  await provider.selectOption("anthropic");
  await expect(provider).toBeEnabled();
  await page.reload();
  await openDiscussion(page, notebookName, discussionName);
  await expect(page.locator("main [data-llm-label]")).toHaveText([
    "Claude · claude-sonnet-5",
    "ChatGPT · gpt-6.1-sol",
  ]);
});
