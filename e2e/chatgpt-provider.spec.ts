import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 81 Stage 2. ChatGPT end to end: the OpenAI key in Account -> Keys,
// the provider dropdown (remembered), the tiers, and a run answered by a
// local stand-in for OpenAI -- a normal answer, a refused key, a missing
// key and a rate limit. No real key, nothing spent.
//
// The stand-in is reached through the stored key "sk-e2e-mock-openai-
// <port>" (lib/llm/openai.ts, openaiUrlFor). What it answers depends on
// the prompt: "please 401" and "please 429" get those refusals, anything
// else a streamed answer quoting the prompt.

let MOCK_KEY = "";
let server: Server;
const received: { auth: string | undefined; body: Record<string, unknown> }[] =
  [];

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async ({}, workerInfo) => {
  const port = 54420 + workerInfo.workerIndex;
  MOCK_KEY = `sk-e2e-mock-openai-${port}`;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      received.push({ auth: req.headers.authorization, body });
      const last = JSON.stringify(body.messages[body.messages.length - 1]);
      if (last.includes("please 401")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Incorrect API key provided: sk-e2e-************.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
        );
        return;
      }
      if (last.includes("please 429")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Rate limit reached.",
              type: "requests",
              code: "rate_limit_exceeded",
            },
          }),
        );
        return;
      }
      const prompt = /"text":"([^"]*)"/.exec(last)?.[1] ?? "";
      const answer = `ChatGPT heard: ${prompt}`;
      const model = `${body.model}-e2e`;
      const chunks = [
        {
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
        },
        ...answer.match(/.{1,5}/g)!.map((content) => ({
          model,
          choices: [{ index: 0, delta: { content } }],
        })),
        { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      let next = 0;
      const tick = setInterval(() => {
        if (next < chunks.length) {
          res.write(
            `data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", ...chunks[next++] })}\n\n`,
          );
          return;
        }
        clearInterval(tick);
        res.end("data: [DONE]\n\n");
      }, 40);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function admin() {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
  return {
    API_URL: API_URL as string,
    ANON_KEY: ANON_KEY as string,
    client: createServiceClient(API_URL, SERVICE_ROLE_KEY),
  };
}

async function seed(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, client } = admin();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-chatgpt-${suffix}@example.com`;
  const password = "chatgpt provider e2e 81!";
  const discussionName = `E2E chatgpt discussion ${suffix}`;
  const { data: created } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.user!.id;
  const { data: notebook } = await client
    .from("notebooks")
    .insert({ user_id: userId, name: `E2E chatgpt notebook ${suffix}` })
    .select()
    .single();
  await client.from("discussions").insert({
    notebook_id: notebook!.id,
    user_id: userId,
    name: discussionName,
  });

  const jar: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
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
  await jarClient.auth.signInWithPassword({ email, password });
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
  await openDiscussion(page, discussionName);
  return { userId, discussionName, admin: client };
}

async function openDiscussion(page: Page, discussionName: string) {
  await page.goto("/");
  await page.getByRole("treeitem", { name: discussionName }).click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(discussionName, { timeout: 15_000 });
}

async function saveOpenAiKey(page: Page, key: string) {
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();
  await dialog.getByText("ChatGPT (optional)").click();
  const group = dialog.getByRole("group", { name: "OpenAI key" });
  await group.getByLabel("OpenAI API key:").fill(key);
  await group.getByRole("button", { name: "Save" }).click();
  await expect(group.getByText("API key saved.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
}

const provider = (page: Page) =>
  page.locator("header").getByRole("combobox", { name: "Provider" });

async function chooseChatGpt(page: Page) {
  await provider(page).selectOption("openai");
  // Saved on the user before Run can be pressed.
  await expect(provider(page)).toBeEnabled();
}

async function run(page: Page, text: string) {
  await page.getByLabel("Prompt").fill(text);
  const runButton = page.locator("header").getByRole("button", { name: "Run" });
  await expect(runButton).toBeEnabled();
  await runButton.click();
}

const alert = (page: Page) => page.locator("main").getByRole("alert");

test("a user who never adds an OpenAI key sees Claude, and a closed ChatGPT section", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(provider(page)).toHaveValue("anthropic");
  await expect(provider(page).locator("option:checked")).toHaveText(
    "Claude · claude-sonnet-5",
  );

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();
  await expect(dialog.getByText("ChatGPT (optional)")).toBeVisible();
  await expect(dialog.getByLabel("OpenAI API key:")).toBeHidden();
});

test("ChatGPT end to end: key saved, choice remembered, answer streamed and stored with both model names", async ({
  page,
  context,
}) => {
  const { userId, discussionName, admin } = await seed(page, context);
  await saveOpenAiKey(page, MOCK_KEY);
  await chooseChatGpt(page);
  await expect(provider(page).locator("option:checked")).toHaveText(
    "ChatGPT · gpt-6.1-sol",
  );

  // Remembered per user: still ChatGPT after a reload.
  await openDiscussion(page, discussionName);
  await expect(provider(page)).toHaveValue("openai");

  // The Keys tab opens the ChatGPT section by itself once a key is saved.
  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();
  await expect(dialog.getByLabel("OpenAI API key:")).toHaveAttribute(
    "placeholder",
    /^Saved \(/,
  );
  await dialog.getByRole("button", { name: "Close" }).click();

  received.length = 0;
  await run(page, "hello from the e2e test");
  await expect(
    page.getByText("ChatGPT heard: hello from the e2e test"),
  ).toBeVisible({
    timeout: 20_000,
  });
  expect(received).toHaveLength(1);
  expect(received[0].auth).toBe(`Bearer ${MOCK_KEY}`);
  expect(received[0].body.model).toBe("gpt-6.1-sol");

  const { data: rows } = await admin
    .from("responses")
    .select("response, model, resolved_model")
    .eq("user_id", userId);
  expect(rows).toEqual([
    {
      response: "ChatGPT heard: hello from the e2e test",
      model: "gpt-6.1-sol",
      resolved_model: "gpt-6.1-sol-e2e",
    },
  ]);
});

test("the Model tiers apply to ChatGPT: Economy runs on gpt-6-luna", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await saveOpenAiKey(page, MOCK_KEY);
  await chooseChatGpt(page);

  await page.locator("header").getByRole("button", { name: "Model" }).click();
  const tiers = page.getByRole("dialog", { name: "Model tier" });
  await expect(tiers).toContainText("Models shown for ChatGPT.");
  await expect(tiers).toContainText("gpt-6.1-sol");
  await tiers.getByRole("button", { name: /Economy/ }).click();
  await expect(tiers).toBeHidden();
  await expect(provider(page).locator("option:checked")).toHaveText(
    "ChatGPT · gpt-6-luna",
  );

  received.length = 0;
  await run(page, "economy question");
  await expect(page.getByText("ChatGPT heard: economy question")).toBeVisible({
    timeout: 20_000,
  });
  expect(received[0].body.model).toBe("gpt-6-luna");
});

test("ChatGPT chosen with no OpenAI key: the run does not start, and says where to fix it", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await chooseChatGpt(page);
  received.length = 0;
  await run(page, "no key yet");
  await expect(alert(page)).toHaveText(
    "Add your OpenAI API key in Account → Keys before running prompts on ChatGPT.",
    { timeout: 20_000 },
  );
  expect(received).toHaveLength(0);
});

test("a key OpenAI refuses, and a rate limit, each get their plain message", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await saveOpenAiKey(page, MOCK_KEY);
  await chooseChatGpt(page);

  await run(page, "please 401");
  await expect(alert(page)).toHaveText(
    "OpenAI rejected your API key. Check it in Account → Keys.",
    { timeout: 20_000 },
  );

  await run(page, "please 429");
  await expect(alert(page)).toHaveText(
    "OpenAI is limiting requests on your key right now. Wait a minute, then run again.",
    { timeout: 20_000 },
  );
  // Neither shows OpenAI's own words, the key, or an error id.
  await expect(alert(page)).not.toContainText(
    /sk-|error id|Rate limit reached/,
  );
});

test("switching back to Claude: the next run goes to Claude, not OpenAI", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await saveOpenAiKey(page, MOCK_KEY);
  await chooseChatGpt(page);
  await provider(page).selectOption("anthropic");
  await expect(provider(page)).toBeEnabled();
  received.length = 0;
  await run(page, "back on claude");
  // No Anthropic key saved: Claude's own missing-key message.
  await expect(alert(page)).toHaveText(
    /Add your Anthropic API key in Account/,
    { timeout: 20_000 },
  );
  expect(received).toHaveLength(0);
});
