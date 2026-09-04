// @vitest-environment node
import { expect, test } from "vitest";
import { mockAnthropicMessageResponse } from "./mocks/handlers";

test("MSW intercepts POST https://api.anthropic.com/v1/messages", async () => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "ping" }],
    }),
  });

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual(mockAnthropicMessageResponse);
});
