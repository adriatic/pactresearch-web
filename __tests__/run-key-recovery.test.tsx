import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  OPEN_KEYS_LABEL,
  REJECTED_KEY_WORDS,
  rejectedKeyProvider,
} from "@/lib/rejectedKeyWords";
import { RunKeyError } from "@/app/RunKeyError";
import { AccountDialog } from "@/app/AccountDialog";
import { RefineConversation } from "@/app/RefineConversation";

// Task D17k. The way out of a Run (or Refine) refused for a rejected key:
// which errors get it, the error's own buttons, Account opening on Keys
// and saying which service's key was saved, and Refine's button.

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { email: "someone@example.com", user_metadata: {} } },
      }),
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("which errors are a refused key", () => {
  test("the two refused-key codes name their service", () => {
    expect(rejectedKeyProvider("anthropic_rejected_key")).toBe("anthropic");
    expect(rejectedKeyProvider("openai_rejected_key")).toBe("openai");
    expect(rejectedKeyProvider(REJECTED_KEY_WORDS.openai.code)).toBe("openai");
  });

  test("anything else is not", () => {
    for (const code of [
      null,
      undefined,
      "",
      "rejected_key",
      "anthropic_missing_key",
      "missing_api_key",
      "openai_rate_limited",
      42,
    ]) {
      expect(rejectedKeyProvider(code)).toBeNull();
    }
  });
});

describe("the Run's refused-key error", () => {
  test("shows the words unchanged, with Open Account → Keys and Dismiss", () => {
    const onOpenKeys = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RunKeyError
        message={REJECTED_KEY_WORDS.anthropic.error}
        onOpenKeys={onOpenKeys}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      REJECTED_KEY_WORDS.anthropic.error,
    );
    expect(OPEN_KEYS_LABEL).toBe("Open Account → Keys");
    fireEvent.click(screen.getByRole("button", { name: OPEN_KEYS_LABEL }));
    expect(onOpenKeys).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Account", () => {
  function stubKeyRoutes() {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(200, { hint: "…abcd" });
      return json(200, { hasKey: url.includes("openai"), hint: "…wxyz" });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("opened with initialTab keys, it shows Keys", async () => {
    stubKeyRoutes();
    render(<AccountDialog open onClose={() => {}} initialTab="keys" />);
    expect(
      screen.getByRole("tab", { name: "Keys" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Keys" })).toBeTruthy();
  });

  test("opened without it, it shows Profile as before", () => {
    stubKeyRoutes();
    render(<AccountDialog open onClose={() => {}} />);
    expect(
      screen
        .getByRole("tab", { name: "Profile" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("saving a key says which service's key was saved", async () => {
    stubKeyRoutes();
    const onKeySaved = vi.fn();
    render(
      <AccountDialog
        open
        onClose={() => {}}
        initialTab="keys"
        onKeySaved={onKeySaved}
      />,
    );
    // Opening the tab reads the status: that is not a save.
    await waitFor(() =>
      expect(screen.getByLabelText("OpenAI API key:")).toBeTruthy(),
    );
    expect(onKeySaved).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("OpenAI API key:"), {
      target: { value: "sk-new-key" },
    });
    // The OpenAI field's Save is the second of the two.
    const saves = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(onKeySaved).toHaveBeenCalledWith("openai"));
    expect(onKeySaved).not.toHaveBeenCalledWith("anthropic");
  });
});

describe("Refine with AI", () => {
  function stubRefine(code: string, error: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? json(400, { error, code })
          : json(200, { messages: [] }),
      ),
    );
  }

  async function sendAndFail(onOpenKeys?: () => void) {
    render(
      <RefineConversation
        notebookId="nb-1"
        provider="openai"
        onUsePrompt={() => {}}
        onOpenKeys={onOpenKeys}
      />,
    );
    const input = await screen.findByRole("textbox", {
      name: "Refine with AI",
    });
    await waitFor(() =>
      expect((input as HTMLTextAreaElement).disabled).toBe(false),
    );
    fireEvent.change(input, { target: { value: "make it shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
  }

  test("a refused key gets Open Account → Keys under its error", async () => {
    stubRefine("openai_rejected_key", REJECTED_KEY_WORDS.openai.error);
    const onOpenKeys = vi.fn();
    await sendAndFail(onOpenKeys);
    fireEvent.click(screen.getByRole("button", { name: OPEN_KEYS_LABEL }));
    expect(onOpenKeys).toHaveBeenCalledTimes(1);
  });

  test("another error does not", async () => {
    stubRefine("openai_rate_limited", "OpenAI is limiting requests.");
    await sendAndFail(vi.fn());
    expect(screen.queryByRole("button", { name: OPEN_KEYS_LABEL })).toBeNull();
  });

  test("without onOpenKeys (New Notebook) there is no button", async () => {
    stubRefine("openai_rejected_key", REJECTED_KEY_WORDS.openai.error);
    await sendAndFail(undefined);
    expect(screen.queryByRole("button", { name: OPEN_KEYS_LABEL })).toBeNull();
  });
});
