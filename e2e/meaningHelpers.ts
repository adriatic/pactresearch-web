import { createServer, type Server } from "node:http";
import { expect, type Page } from "@playwright/test";

// Task D15. A local stand-in for Anthropic's Messages API, for the
// Meaning engine's browser tests. Never a real call: the route sends a
// key "sk-ant-e2e-mock-<port>" to PACT_E2E_ANTHROPIC_URL (set only by
// playwright.config.ts) on this port. Not a .spec.ts file, so Playwright
// does not collect it as a test.
//
// It records yes/no facts about each request (the model, the structured
// output, the effort), never the texts or the key.

export type MockMode = "ok" | "slow" | "reject" | "error";

export const FINDINGS = [
  {
    topic: "Adapter naming",
    type: "conflict",
    a: "provider adapters",
    b: "model adapters",
    explanation: "A names the adapters after providers, B after models.",
  },
  {
    topic: "Cancelling state",
    type: "unique",
    a: "(not mentioned)",
    b: "Mark a run as cancelling and wait for confirmation.",
    explanation: "Only B waits for confirmation before stopping.",
  },
  {
    topic: "Retry cell",
    type: "uncertain",
    a: "A retry creates a new execution cell.",
    b: "A retry creates a new attempt within the same cell.",
    explanation: "Whether a retry is a new cell is stated differently.",
  },
  {
    topic: "Event bus",
    type: "agreement",
    a: "Stream tokens through a shared event bus.",
    b: "Stream provider deltas through a normalized event interface.",
    explanation: "Both stream the output through one shared channel.",
  },
] as const;

export const USAGE = { input_tokens: 3512, output_tokens: 1840 };

export interface MockAnthropic {
  key: string;
  calls: () => number;
  /** Per request: model, json_schema output and medium effort were sent. */
  shapes: () => boolean[];
  setMode: (mode: MockMode) => void;
  close: () => Promise<void>;
}

export async function startMockAnthropic(port: number): Promise<MockAnthropic> {
  let mode: MockMode = "ok";
  let calls = 0;
  const shapes: boolean[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls += 1;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        shapes.push(
          body.model === "claude-opus-5-5" &&
            body.output_config?.effort === "medium" &&
            body.output_config?.format?.type === "json_schema" &&
            body.stream === undefined,
        );
      } catch {
        shapes.push(false);
      }
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_e2e_meaning",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [
              { type: "text", text: JSON.stringify({ findings: FINDINGS }) },
            ],
            stop_reason: "end_turn",
            usage: USAGE,
          }),
        );
      };
      if (mode === "reject") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          }),
        );
      } else if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Internal server error" },
          }),
        );
      } else if (mode === "slow") {
        setTimeout(answer, 2500);
      } else {
        answer();
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    key: `sk-ant-e2e-mock-${port}`,
    calls: () => calls,
    shapes: () => [...shapes],
    setMode: (m) => {
      mode = m;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Saves the stand-in's key as the signed-in user's Anthropic key, as Account, Keys does. */
export async function saveMockKey(page: Page, key: string) {
  const response = await page.request.post("/api/account/anthropic-key", {
    data: { key },
  });
  expect(response.ok()).toBe(true);
}

export const meaningNote = (page: Page) => page.locator("[data-meaning-note]");
export const compareButton = (page: Page) =>
  page.getByRole("button", { name: "Compare", exact: true });
