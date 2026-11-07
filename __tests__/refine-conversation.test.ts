import { describe, expect, test } from "vitest";
import {
  checkSentConversation,
  checkStoredConversation,
  extractPrompt,
  latestPrompt,
  PROMPT_END_MARKER as END,
  PROMPT_START_MARKER as START,
  REFINE_INCOMPLETE_NOTE,
  REFINE_MAX_ASSISTANT_CHARS,
  REFINE_MAX_MESSAGES,
  REFINE_MAX_OUTPUT_TOKENS,
  REFINE_MAX_TOTAL_CHARS,
  REFINE_MAX_USER_CHARS,
  REFINE_TIMEOUT_MS,
  REFINE_WORDS,
  refineCaseForProblem,
  refineMessageLabel,
  refineProviderLabel,
  refineWords,
  type RefineCase,
  type RefineMessage,
} from "@/lib/refineConversation";
import { REFINE_MISSING_KEY_MESSAGE } from "@/lib/refineDraft";
import * as anthropicKey from "@/lib/userAnthropicKey";
import * as openAiKey from "@/lib/userOpenAiKey";

// Task D17b. The shared library for Refine with AI as a conversation.

const user = (content = "a question"): RefineMessage => ({
  role: "user",
  content,
});
const assistant = (
  content = "an answer",
  provider?: "anthropic" | "openai",
): RefineMessage =>
  provider
    ? { role: "assistant", content, provider }
    : { role: "assistant", content };

// An alternating conversation of n messages, user first.
const turns = (n: number): RefineMessage[] =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`),
  );

describe("limits", () => {
  test("the values Nik accepted from the D17a report", () => {
    expect(REFINE_MAX_MESSAGES).toBe(40);
    expect(REFINE_MAX_USER_CHARS).toBe(2000);
    expect(REFINE_MAX_ASSISTANT_CHARS).toBe(12000);
    expect(REFINE_MAX_TOTAL_CHARS).toBe(60000);
    expect(REFINE_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(REFINE_TIMEOUT_MS).toBe(60000);
  });
});

describe("checkSentConversation: shape", () => {
  test("one user message is a valid conversation", () => {
    expect(checkSentConversation([user("hi")])).toEqual({
      ok: true,
      messages: [user("hi")],
    });
  });

  test("user, assistant (with its provider), user is valid and keeps the provider", () => {
    const sent = [user(), assistant("q?", "openai"), user("answer")];
    expect(checkSentConversation(sent)).toEqual({ ok: true, messages: sent });
  });

  test.each([
    ["an object", { messages: [] }],
    ["a string", "hi"],
    ["null", null],
    ["undefined", undefined],
  ])("not a list (%s) is refused", (_name, value) => {
    expect(checkSentConversation(value)).toEqual({
      ok: false,
      reason: "not_a_list",
    });
  });

  test("an empty list is refused", () => {
    expect(checkSentConversation([])).toEqual({ ok: false, reason: "empty" });
  });

  test.each([
    ["null", null],
    ["a string", "hi"],
    ["an array", ["user", "hi"]],
    ["an unknown role", { role: "system", content: "hi" }],
    ["no content", { role: "user" }],
    ["content not a string", { role: "user", content: 5 }],
    ["an unknown field", { role: "user", content: "hi", id: 1 }],
  ])("a message that is %s is refused", (_name, message) => {
    expect(checkSentConversation([message])).toEqual({
      ok: false,
      reason: "bad_message",
    });
  });

  test("blank content is refused", () => {
    expect(checkSentConversation([user("  \n ")])).toEqual({
      ok: false,
      reason: "empty_message",
    });
  });

  test("the first message must be from the user", () => {
    expect(checkSentConversation([assistant(), user()])).toEqual({
      ok: false,
      reason: "first_not_user",
    });
  });

  test("two user messages in a row are refused", () => {
    expect(checkSentConversation([user(), user()])).toEqual({
      ok: false,
      reason: "not_alternating",
    });
  });

  test("two assistant messages in a row are refused", () => {
    expect(
      checkSentConversation([user(), assistant(), assistant(), user()]),
    ).toEqual({
      ok: false,
      reason: "not_alternating",
    });
  });

  test("the last message must be from the user", () => {
    expect(checkSentConversation([user(), assistant()])).toEqual({
      ok: false,
      reason: "last_not_user",
    });
  });

  test("provider on a user message is refused", () => {
    expect(
      checkSentConversation([
        { role: "user", content: "hi", provider: "anthropic" },
      ]),
    ).toEqual({ ok: false, reason: "provider_on_user_message" });
  });

  test.each([["google"], [""], [null], [1], ["constructor"], ["toString"]])(
    "an unknown provider (%j) on an assistant message is refused",
    (provider) => {
      expect(
        checkSentConversation([
          user(),
          { role: "assistant", content: "x", provider },
          user(),
        ]),
      ).toEqual({ ok: false, reason: "unknown_provider" });
    },
  );

  test("the copy returned holds only the known fields", () => {
    const result = checkSentConversation([user()]);
    expect(result.ok && Object.keys(result.messages[0])).toEqual([
      "role",
      "content",
    ]);
  });
});

describe("checkSentConversation: limits, at the limit and one over", () => {
  test(`${REFINE_MAX_MESSAGES - 1} messages (the most a sent conversation can have) pass`, () => {
    expect(checkSentConversation(turns(REFINE_MAX_MESSAGES - 1)).ok).toBe(true);
  });

  test(`${REFINE_MAX_MESSAGES + 1} messages are refused as too many`, () => {
    expect(checkSentConversation(turns(REFINE_MAX_MESSAGES + 1))).toEqual({
      ok: false,
      reason: "too_many_messages",
    });
  });

  test(`a user message of ${REFINE_MAX_USER_CHARS} characters passes, one more is refused`, () => {
    expect(
      checkSentConversation([user("x".repeat(REFINE_MAX_USER_CHARS))]).ok,
    ).toBe(true);
    expect(
      checkSentConversation([user("x".repeat(REFINE_MAX_USER_CHARS + 1))]),
    ).toEqual({
      ok: false,
      reason: "user_message_too_long",
    });
  });

  test(`an assistant message of ${REFINE_MAX_ASSISTANT_CHARS} characters passes, one more is refused`, () => {
    const at = [
      user(),
      assistant("y".repeat(REFINE_MAX_ASSISTANT_CHARS)),
      user(),
    ];
    expect(checkSentConversation(at).ok).toBe(true);
    const over = [
      user(),
      assistant("y".repeat(REFINE_MAX_ASSISTANT_CHARS + 1)),
      user(),
    ];
    expect(checkSentConversation(over)).toEqual({
      ok: false,
      reason: "assistant_message_too_long",
    });
  });

  // 5 exchanges of 2,000 + 10,000, then a last user message: 60,000 exactly.
  function totalOf(extra: number): RefineMessage[] {
    const messages: RefineMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      messages.push(user("u".repeat(2000)), assistant("a".repeat(10000)));
    }
    // 60,000 already; the last user message adds `extra`, at least 1.
    messages[9] = assistant("a".repeat(10000 - 1));
    messages.push(user("u".repeat(1 + extra)));
    return messages;
  }

  test(`${REFINE_MAX_TOTAL_CHARS} characters in total pass, one more is refused`, () => {
    const at = totalOf(0);
    expect(at.reduce((n, m) => n + m.content.length, 0)).toBe(
      REFINE_MAX_TOTAL_CHARS,
    );
    expect(checkSentConversation(at).ok).toBe(true);
    const over = totalOf(1);
    expect(over.reduce((n, m) => n + m.content.length, 0)).toBe(
      REFINE_MAX_TOTAL_CHARS + 1,
    );
    expect(checkSentConversation(over)).toEqual({
      ok: false,
      reason: "total_too_long",
    });
  });
});

describe("checkStoredConversation", () => {
  test("an empty list is no conversation yet, and valid", () => {
    expect(checkStoredConversation([])).toEqual({ ok: true, messages: [] });
  });

  test("it may end with the assistant", () => {
    expect(
      checkStoredConversation([user(), assistant("q?", "anthropic")]).ok,
    ).toBe(true);
  });

  test(`${REFINE_MAX_MESSAGES} messages pass, ${REFINE_MAX_MESSAGES + 1} are refused`, () => {
    expect(checkStoredConversation(turns(REFINE_MAX_MESSAGES)).ok).toBe(true);
    expect(checkStoredConversation(turns(REFINE_MAX_MESSAGES + 1))).toEqual({
      ok: false,
      reason: "too_many_messages",
    });
  });

  test("the other rules still hold", () => {
    expect(checkStoredConversation([assistant()])).toEqual({
      ok: false,
      reason: "first_not_user",
    });
    expect(checkStoredConversation([user(), user()])).toEqual({
      ok: false,
      reason: "not_alternating",
    });
    expect(
      checkStoredConversation([
        { role: "user", content: "x", provider: "openai" },
      ]),
    ).toEqual({ ok: false, reason: "provider_on_user_message" });
    expect(checkStoredConversation("x")).toEqual({
      ok: false,
      reason: "not_a_list",
    });
  });
});

describe("extractPrompt", () => {
  test("no markers: no prompt, not incomplete", () => {
    expect(extractPrompt("What field do you work in?")).toEqual({
      prompt: null,
      incomplete: false,
    });
  });

  test("one pair", () => {
    expect(extractPrompt(`${START}\nYou are a historian.\n${END}`)).toEqual({
      prompt: "You are a historian.",
      incomplete: false,
    });
  });

  test("two pairs: the last is used", () => {
    const reply = `${START}\nfirst\n${END}\nor better:\n${START}\nsecond\n${END}`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "second",
      incomplete: false,
    });
  });

  test("start only: incomplete, no prompt", () => {
    expect(extractPrompt(`Here it is:\n${START}\nYou are a hist`)).toEqual({
      prompt: null,
      incomplete: true,
    });
  });

  test("end only: no prompt, not incomplete", () => {
    expect(extractPrompt(`You are a historian.\n${END}\nMore?`)).toEqual({
      prompt: null,
      incomplete: false,
    });
  });

  test("a complete pair followed by an unfinished one: the pair, and incomplete", () => {
    const reply = `${START}\nfirst\n${END}\n${START}\nsecond, cut`;
    expect(extractPrompt(reply)).toEqual({ prompt: "first", incomplete: true });
  });

  test("a second start before the end restarts the prompt", () => {
    expect(extractPrompt(`${START}\ndraft\n${START}\nfinal\n${END}`)).toEqual({
      prompt: "final",
      incomplete: false,
    });
  });

  test("spaces around the markers and blank lines inside are trimmed; inner lines kept", () => {
    const reply = `   ${START}  \r\n\n\n  You are a historian.\n\n  Be careful.  \n\n\t${END}\t\n`;
    expect(extractPrompt(reply)).toEqual({
      prompt: "You are a historian.\n\n  Be careful.",
      incomplete: false,
    });
  });

  test("text around the markers is ignored", () => {
    const reply =
      `Thanks, that is everything I need.\n\n${START}\nYou are a historian.\n${END}\n\n` +
      "Would you like to refine it further?";
    expect(extractPrompt(reply)).toEqual({
      prompt: "You are a historian.",
      incomplete: false,
    });
  });

  test("markers named inside a sentence are not markers", () => {
    const reply = `I will write it between ${START} and ${END} once I know more.`;
    expect(extractPrompt(reply)).toEqual({ prompt: null, incomplete: false });
  });

  test("a pair with nothing between is no prompt", () => {
    expect(extractPrompt(`${START}\n  \n${END}`)).toEqual({
      prompt: null,
      incomplete: false,
    });
  });
});

describe("latestPrompt", () => {
  const withPrompt = (text: string) =>
    `Here:\n${START}\n${text}\n${END}\nRefine further?`;

  test("none in the conversation", () => {
    expect(latestPrompt([])).toBeNull();
    expect(latestPrompt([user(), assistant("Which field?")])).toBeNull();
  });

  test("the newest assistant message with a complete pair, and its index", () => {
    const messages = [
      user(),
      assistant(withPrompt("old")),
      user(),
      assistant(withPrompt("new")),
      user(),
    ];
    expect(latestPrompt(messages)).toEqual({ prompt: "new", index: 3 });
  });

  test("a later reply without a prompt does not hide an earlier one", () => {
    const messages = [
      user(),
      assistant(withPrompt("kept")),
      user(),
      assistant("Which part?"),
    ];
    expect(latestPrompt(messages)).toEqual({ prompt: "kept", index: 1 });
  });

  test("an unfinished prompt in a later reply does not replace a complete one", () => {
    const messages = [
      user(),
      assistant(withPrompt("kept")),
      user(),
      assistant(`${START}\ncut`),
    ];
    expect(latestPrompt(messages)).toEqual({ prompt: "kept", index: 1 });
  });

  test("markers in a user message are not a prompt", () => {
    expect(latestPrompt([user(withPrompt("mine"))])).toBeNull();
  });
});

describe("labels", () => {
  test("anthropic is Claude, openai is ChatGPT", () => {
    expect(refineProviderLabel("anthropic")).toBe("Claude");
    expect(refineProviderLabel("openai")).toBe("ChatGPT");
  });

  test("an assistant message is labelled by the provider that wrote it", () => {
    expect(refineMessageLabel(assistant("x", "anthropic"))).toBe("Claude");
    expect(refineMessageLabel(assistant("x", "openai"))).toBe("ChatGPT");
  });

  test("a user message, or a reply with no provider, has no label", () => {
    expect(refineMessageLabel(user())).toBeNull();
    expect(refineMessageLabel(assistant("x"))).toBeNull();
  });
});

describe("words", () => {
  test("missing key: today's Anthropic wording and the new OpenAI one", () => {
    expect(refineWords("missing_key", "anthropic")).toEqual({
      error: REFINE_MISSING_KEY_MESSAGE,
      code: anthropicKey.MISSING_KEY_CODE,
    });
    expect(refineWords("missing_key", "openai")).toEqual({
      error:
        "Refine with AI needs your OpenAI API key. Add it in Account → Keys, " +
        "then try again. Nothing was sent.",
      code: openAiKey.OPENAI_MISSING_KEY_CODE,
    });
  });

  // The copies of server-only constants equal their originals.
  test.each<[RefineCase, "anthropic" | "openai", string, string]>([
    [
      "unreadable_key",
      "anthropic",
      anthropicKey.UNREADABLE_KEY_MESSAGE,
      anthropicKey.UNREADABLE_KEY_CODE,
    ],
    [
      "unreadable_key",
      "openai",
      openAiKey.OPENAI_UNREADABLE_KEY_MESSAGE,
      openAiKey.OPENAI_UNREADABLE_KEY_CODE,
    ],
    [
      "key_encryption_unconfigured",
      "anthropic",
      anthropicKey.KEY_ENCRYPTION_UNCONFIGURED_MESSAGE,
      anthropicKey.KEY_ENCRYPTION_UNCONFIGURED_CODE,
    ],
    [
      "key_encryption_unconfigured",
      "openai",
      openAiKey.OPENAI_KEY_ENCRYPTION_UNCONFIGURED_MESSAGE,
      anthropicKey.KEY_ENCRYPTION_UNCONFIGURED_CODE,
    ],
    [
      "rejected_key",
      "anthropic",
      anthropicKey.REJECTED_KEY_MESSAGE,
      anthropicKey.REJECTED_KEY_CODE,
    ],
    [
      "rejected_key",
      "openai",
      openAiKey.OPENAI_REJECTED_KEY_MESSAGE,
      openAiKey.OPENAI_REJECTED_KEY_CODE,
    ],
    [
      "no_credit",
      "openai",
      openAiKey.OPENAI_NO_CREDIT_MESSAGE,
      openAiKey.OPENAI_NO_CREDIT_CODE,
    ],
    [
      "spend_limit",
      "openai",
      openAiKey.OPENAI_SPEND_LIMIT_MESSAGE,
      openAiKey.OPENAI_SPEND_LIMIT_CODE,
    ],
    [
      "rate_limited",
      "openai",
      openAiKey.OPENAI_RATE_LIMITED_MESSAGE,
      openAiKey.OPENAI_RATE_LIMITED_CODE,
    ],
  ])(
    "%s for %s equals the existing constant",
    (refineCase, provider, error, code) => {
      expect(refineWords(refineCase, provider)).toEqual({ error, code });
    },
  );

  test("OpenAI's refusals carry OpenAI's own reason, as /api/execute shows them", () => {
    expect(refineWords("no_credit", "openai", "insufficient_quota").error).toBe(
      `${openAiKey.OPENAI_NO_CREDIT_MESSAGE} (OpenAI: insufficient_quota)`,
    );
    expect(
      refineWords("rate_limited", "openai", "rate_limit_exceeded").error,
    ).toBe(
      `${openAiKey.OPENAI_RATE_LIMITED_MESSAGE} (OpenAI: rate_limit_exceeded)`,
    );
  });

  test("no reason is added to other cases, or for Anthropic", () => {
    expect(refineWords("rejected_key", "openai", "invalid_api_key").error).toBe(
      openAiKey.OPENAI_REJECTED_KEY_MESSAGE,
    );
    expect(refineWords("no_credit", "anthropic", "x").error).toBe(
      "Couldn't get a reply from Claude. Please try again.",
    );
  });

  test("Anthropic's no-credit, spend-limit and rate-limit refusals are the generic words", () => {
    for (const refineCase of [
      "no_credit",
      "spend_limit",
      "rate_limited",
    ] as const) {
      expect(refineWords(refineCase, "anthropic")).toEqual(
        refineWords("provider_error", "anthropic"),
      );
    }
  });

  test.each<[RefineCase, string, string]>([
    [
      "provider_error",
      "Couldn't get a reply from Claude. Please try again.",
      "Couldn't get a reply from ChatGPT. Please try again.",
    ],
    [
      "timeout",
      "Claude did not answer within 60 seconds. Please try again.",
      "ChatGPT did not answer within 60 seconds. Please try again.",
    ],
    [
      "empty_reply",
      "Claude returned nothing. Please try again.",
      "ChatGPT returned nothing. Please try again.",
    ],
  ])("%s names the provider", (refineCase, claude, chatgpt) => {
    expect(refineWords(refineCase, "anthropic").error).toBe(claude);
    expect(refineWords(refineCase, "openai").error).toBe(chatgpt);
  });

  test.each<[RefineCase, string]>([
    [
      "cut_off",
      "The reply was cut off before it was finished. Please try again.",
    ],
    ["network", "Couldn't reach pact-web. Please try again."],
    [
      "too_many_messages",
      "This conversation is at its limit of 40 messages. Use the prompt you have, or start over.",
    ],
    [
      "message_too_long",
      "That message is too long — 2,000 characters at most.",
    ],
    ["notebook_not_found", "This notebook no longer exists."],
  ])(
    "%s is the D17a wording, the same for both providers",
    (refineCase, words) => {
      expect(refineWords(refineCase, "anthropic").error).toBe(words);
      expect(refineWords(refineCase, "openai")).toEqual(
        refineWords(refineCase, "anthropic"),
      );
    },
  );

  test("every case has words and a code for both providers", () => {
    for (const [refineCase, perProvider] of Object.entries(REFINE_WORDS)) {
      for (const provider of ["anthropic", "openai"] as const) {
        expect(
          perProvider[provider].error,
          `${refineCase} ${provider}`,
        ).toMatch(/\S/);
        expect(perProvider[provider].code, `${refineCase} ${provider}`).toMatch(
          /^[a-z_]+$/,
        );
      }
    }
  });

  test("a refused conversation maps to words, never to its text", () => {
    expect(refineCaseForProblem("too_many_messages")).toBe("too_many_messages");
    expect(refineCaseForProblem("user_message_too_long")).toBe(
      "message_too_long",
    );
    expect(refineCaseForProblem("assistant_message_too_long")).toBe(
      "conversation_too_long",
    );
    expect(refineCaseForProblem("total_too_long")).toBe(
      "conversation_too_long",
    );
    for (const problem of [
      "not_a_list",
      "empty",
      "bad_message",
      "empty_message",
      "provider_on_user_message",
      "unknown_provider",
      "first_not_user",
      "not_alternating",
      "last_not_user",
    ] as const) {
      expect(refineCaseForProblem(problem)).toBe("invalid_conversation");
    }
  });

  test("save failed: the reply is shown but will not be kept (D17d)", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      expect(refineWords("save_failed", provider)).toEqual({
        error:
          "This reply could not be saved. It is shown here, but it will be gone when you close this dialog.",
        code: "refine_save_failed",
      });
    }
  });

  test("the unfinished-prompt note", () => {
    expect(REFINE_INCOMPLETE_NOTE).toBe(
      "This reply has an unfinished prompt (the end marker is missing). Ask for it again.",
    );
  });
});
