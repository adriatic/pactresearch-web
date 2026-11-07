import { expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { LlmProviderId } from "@/lib/llmProviders";
import type { RefineMessage } from "@/lib/refineConversation";
import {
  openSeededDiscussion,
  seedSignedIn,
  type Seeded,
} from "./themeHelpers";

// Task D17e. Shared by the Refine with AI specs: scripted local stand-ins
// for both services, reached through the mock keys (lib/llm/anthropic.ts,
// lib/llm/openai.ts; PACT_E2E_* are set by playwright.config.ts), and a
// signed-in user on either service. No real model is ever called.
//
// The script, by what the last user message says:
//   REJECT       the service refuses the key (401)
//   UNFINISHED   a reply that starts a prompt and never ends it
//   LONGREPLY    a 3,000-character reply (pushes a near-full conversation
//                over the 60,000 total, so it is not stored)
//   SLOW         the reply waits 3 seconds
//   otherwise    the first message gets a question, later ones a marked
//                prompt
// Every reply waits WAIT_MS first, so "… is writing…" can be seen.

export const WAIT_MS = 600;

export const QUESTION = {
  anthropic: "Claude asks: what is your role in this research?",
  openai: "ChatGPT asks: what is your role in this research?",
} as const;

export const PROMPT = {
  anthropic:
    "You are assisting a marine biologist who studies coral reefs.\nBe cautious and cite sources.",
  openai:
    "You are assisting a historian of medieval trade.\nBe critical and quantitative.",
} as const;

export const markedReply = (provider: LlmProviderId) =>
  `Thank you. Here is the system prompt:\nSYSTEM_PROMPT_START\n${PROMPT[provider]}\nSYSTEM_PROMPT_END\nWould you like to refine it further?`;

export const UNFINISHED_REPLY =
  "Here is a start:\nSYSTEM_PROMPT_START\nYou are assisting";

export interface StandIn {
  provider: LlmProviderId;
  key: string;
  calls: () => number;
  close: () => Promise<void>;
}

function lastUserText(body: {
  messages?: { role: string; content: unknown }[];
}): { text: string; users: number } {
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  const content = users.at(-1)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? "").join("")
        : "";
  return { text, users: users.length };
}

function replyFor(provider: LlmProviderId, text: string, users: number) {
  if (text.includes("UNFINISHED")) return UNFINISHED_REPLY;
  if (text.includes("LONGREPLY")) return "L".repeat(3000);
  return users <= 1 ? QUESTION[provider] : markedReply(provider);
}

function anthropicStream(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_e2e_refine",
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
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  for (const e of events) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

function openaiStream(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const model = "gpt-6.1-sol";
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  for (const c of chunks) {
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-e2e-refine", object: "chat.completion.chunk", model, ...c })}\n\n`,
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function rejectKey(provider: LlmProviderId, res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      provider === "anthropic"
        ? {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          }
        : {
            error: {
              message: "Incorrect API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
    ),
  );
}

export async function startStandIn(
  provider: LlmProviderId,
  port: number,
): Promise<StandIn> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls += 1;
      const { text, users } = lastUserText(JSON.parse(raw || "{}"));
      const wait = text.includes("SLOW") ? 3000 : WAIT_MS;
      setTimeout(() => {
        if (text.includes("REJECT")) return rejectKey(provider, res);
        const reply = replyFor(provider, text, users);
        if (provider === "anthropic") anthropicStream(res, reply);
        else openaiStream(res, reply);
      }, wait);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    provider,
    key:
      provider === "anthropic"
        ? `sk-ant-e2e-mock-${port}`
        : `sk-e2e-mock-openai-${port}`,
    calls: () => calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * A signed-in user on `provider`, with that service's stand-in key saved
 * (unless `withKey` is false), at the seeded discussion.
 */
export async function seedRefineUser(
  page: Page,
  context: BrowserContext,
  opts: { tag: string; provider: LlmProviderId; key?: string },
): Promise<Seeded> {
  const seeded = await seedSignedIn(context, { tag: opts.tag });
  if (opts.provider === "openai") {
    const { error } = await seeded.admin.auth.admin.updateUserById(
      seeded.userId,
      { user_metadata: { llm_provider: "openai" } },
    );
    if (error) throw error;
  }
  if (opts.key) {
    const route =
      opts.provider === "anthropic"
        ? "/api/account/anthropic-key"
        : "/api/account/openai-key";
    const response = await page.request.post(route, {
      data: { key: opts.key },
    });
    expect(response.ok()).toBe(true);
  }
  await openSeededDiscussion(page, seeded);
  await expect(
    page.locator("header").getByRole("combobox", { name: "Provider" }),
  ).toHaveValue(opts.provider);
  return seeded;
}

/** Stores a conversation for the notebook through the route, as New Notebook will. */
export async function putConversation(
  page: Page,
  notebookId: string,
  messages: RefineMessage[],
) {
  const response = await page.request.put("/api/refine-conversation", {
    data: { notebookId, messages },
  });
  expect(response.status(), await response.text()).toBe(200);
}

export async function getConversation(
  page: Page,
  notebookId: string,
): Promise<RefineMessage[]> {
  const response = await page.request.get(
    `/api/refine-conversation?notebookId=${notebookId}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).messages;
}

/** The notebook's saved system prompt, read back through the app's own API. */
export async function savedSystemPrompt(
  page: Page,
  notebookId: string,
): Promise<string | null> {
  const response = await page.request.get(`/api/notebooks?id=${notebookId}`);
  expect(response.ok()).toBe(true);
  const rows = (await response.json()) as { system_prompt: string | null }[];
  return rows[0]?.system_prompt ?? null;
}

/** A stored conversation of `count` alternating messages (user first). */
export function seededConversation(
  count: number,
  provider: LlmProviderId,
  assistantText: (index: number) => string = (i) => `Reply ${i}.`,
): RefineMessage[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { role: "user" as const, content: `Answer ${i}.` }
      : { role: "assistant" as const, content: assistantText(i), provider },
  );
}

export const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Notebook settings" });

export async function openSettings(page: Page) {
  await page
    .locator("header")
    .getByRole("button", { name: "Settings" })
    .click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
