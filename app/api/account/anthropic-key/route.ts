import { makeApiKeyRoute } from "@/lib/apiKeyRoute";

// Task 51. The user's own Anthropic API key: save, check, and the
// deliberate reveal behind the Keys tab's "show" toggle. The handlers are
// shared with the OpenAI key since Task 81 (lib/apiKeyRoute.ts); every
// word and check here is unchanged.
//
// Anthropic keys start sk-ant-. Checked so an obvious paste mistake is
// caught here rather than surfacing as a confusing 401 on the user's
// next run.
export const { GET, POST } = makeApiKeyRoute({
  column: "anthropic_key_encrypted",
  logTag: "anthropic-key",
  name: "Anthropic API key",
  prefix: "sk-ant-",
  prefixMessage: 'An Anthropic API key starts with "sk-ant-".',
});
