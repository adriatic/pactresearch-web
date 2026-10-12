import { makeApiKeyRoute } from "@/lib/apiKeyRoute";

// Task 81 Stage 2. The user's own OpenAI API key, optional, handled
// exactly like the Anthropic key (lib/apiKeyRoute.ts): encrypted before it
// is stored, never logged, and sent back only for the owner's Show.
//
// OpenAI keys start sk- (sk-proj-, sk-svcacct-, or older plain sk-). An
// Anthropic key starts sk- too, so pasting it here is caught by name.
export const { GET, POST } = makeApiKeyRoute({
  column: "openai_key_encrypted",
  logTag: "openai-key",
  name: "OpenAI API key",
  prefix: "sk-",
  prefixMessage: 'An OpenAI API key starts with "sk-".',
  wrongKey: {
    test: (key) => key.startsWith("sk-ant-"),
    message:
      "That looks like an Anthropic key. Paste it in the Anthropic field " +
      "above, and an OpenAI key here.",
  },
});
