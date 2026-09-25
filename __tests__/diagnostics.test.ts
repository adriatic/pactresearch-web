import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  captureDiagnostics,
  describeElement,
  ancestorChain,
  registerDiagnosticEditor,
  CONSOLE_BUFFER_LIMIT,
} from "@/lib/diagnostics";

// Task 39. The property that matters most here is that capturing NEVER
// throws: it runs precisely when the app is already misbehaving, so a
// capture that dies on a missing global or an exotic element is worse
// than useless. Most of these tests are about that, not about happy-path
// shape.

function resetDiagGlobals() {
  const w = window as unknown as Record<string, unknown>;
  delete w.__pactDiagConsole;
  delete w.__pactDiagPointer;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetDiagGlobals();
  registerDiagnosticEditor(null);
});

afterEach(() => {
  registerDiagnosticEditor(null);
});

describe("describeElement / ancestorChain", () => {
  test("null element yields null rather than throwing", () => {
    expect(describeElement(null)).toBeNull();
  });

  test("captures identity, geometry and the layout-relevant styles only", () => {
    document.body.innerHTML = `<div id="outer"><span aria-label="Prompt" role="textbox" class="tiptap">x</span></div>`;
    const snapshot = describeElement(
      document.querySelector("[aria-label='Prompt']"),
    )!;

    expect(snapshot.tag).toBe("SPAN");
    expect(snapshot.ariaLabel).toBe("Prompt");
    expect(snapshot.role).toBe("textbox");
    expect(snapshot.className).toBe("tiptap");
    // The narrow, deliberately-chosen style set -- not a full computed dump.
    expect(Object.keys(snapshot.styles)).toContain("minHeight");
    expect(Object.keys(snapshot.styles)).toContain("flexGrow");
    expect(Object.keys(snapshot.styles)).toContain("overflowY");
    expect(snapshot.rect).toHaveProperty("h");
  });

  test("walks up the ancestor chain and stops at the root, not past it", () => {
    document.body.innerHTML = `<div id="a"><div id="b"><div id="c"></div></div></div>`;
    const chain = ancestorChain(document.getElementById("c"));
    const ids = chain.map((c) => c.id);

    expect(ids.slice(0, 3)).toEqual(["c", "b", "a"]);
    // Terminates cleanly at <html> rather than running off the top.
    expect(chain.length).toBeLessThanOrEqual(8);
    expect(chain.at(-1)!.tag).toBe("HTML");
  });

  test("respects a shallower requested depth", () => {
    document.body.innerHTML = `<div id="a"><div id="b"><div id="c"></div></div></div>`;
    expect(ancestorChain(document.getElementById("c"), 2)).toHaveLength(2);
  });
});

describe("captureDiagnostics", () => {
  test("produces a complete payload with no collector globals present at all", () => {
    // The hostile case: the inline collector never ran (blocked, CSP,
    // whatever). Capture must still succeed.
    const capture = captureDiagnostics();

    expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(capture.console).toEqual([]);
    expect(capture.lastPointerDown).toBeNull();
    expect(capture.editor).toEqual({ present: false });
    expect(capture.errors).toEqual({});
    expect(capture.viewport).toHaveProperty("devicePixelRatio");
  });

  test("reports activeElementIsBody, the signature of a broken-focus bug", () => {
    document.body.innerHTML = `<input id="field" />`;
    expect(captureDiagnostics().activeElementIsBody).toBe(true);

    document.getElementById("field")!.focus();
    const focused = captureDiagnostics();
    expect(focused.activeElementIsBody).toBe(false);
    expect(focused.activeElement!.tag).toBe("INPUT");
    expect(focused.focusChain.length).toBeGreaterThan(1);
  });

  test("includes the composer chain even when the composer is not focused", () => {
    document.body.innerHTML = `<div id="wrap"><div aria-label="Prompt"></div></div>`;
    const capture = captureDiagnostics();

    expect(capture.composerChain.length).toBeGreaterThan(1);
    expect(capture.composerChain[0].ariaLabel).toBe("Prompt");
    expect(capture.activeElementIsBody).toBe(true);
  });

  test("reads the pointer position and hit-tests it", () => {
    document.body.innerHTML = `<div id="target"></div>`;
    (window as unknown as Record<string, unknown>).__pactDiagPointer = {
      x: 5,
      y: 6,
      t: 1234,
    };
    const capture = captureDiagnostics();

    expect(capture.lastPointerDown!.x).toBe(5);
    expect(capture.lastPointerDown!.tSincePageLoadMs).toBe(1234);
    // jsdom's elementFromPoint may legitimately return null; the shape
    // must hold either way rather than throwing.
    expect(capture.lastPointerDown).toHaveProperty("hitTest");
  });

  test("returns the most recent entries when the console buffer is over the limit", () => {
    const overflowing = Array.from(
      { length: CONSOLE_BUFFER_LIMIT + 50 },
      (_, i) => ({
        t: i,
        level: "log",
        args: [`entry ${i}`],
      }),
    );
    (window as unknown as Record<string, unknown>).__pactDiagConsole =
      overflowing;

    const captured = captureDiagnostics().console;
    expect(captured).toHaveLength(CONSOLE_BUFFER_LIMIT);
    // Most recent kept, oldest dropped.
    expect(captured.at(-1)!.args[0]).toBe(`entry ${CONSOLE_BUFFER_LIMIT + 49}`);
  });

  test("a throwing editor is recorded as an error, not propagated", () => {
    registerDiagnosticEditor({
      get isDestroyed(): boolean {
        throw new Error("editor exploded");
      },
    } as never);

    const capture = captureDiagnostics();
    expect(capture.editor).toEqual({ present: false });
    expect(capture.errors.editor).toContain("editor exploded");
    // The rest of the payload survives the failure of one section.
    expect(capture.capturedAt).toBeTruthy();
    expect(capture.viewport).toHaveProperty("width");
  });

  test("reports a live editor's instance state, and a char count rather than prompt text", () => {
    registerDiagnosticEditor({
      isDestroyed: false,
      isEditable: true,
      isFocused: false,
      isEmpty: true,
      view: { dom: document.createElement("div") },
      getText: () => "hello world",
    } as never);

    const { editor } = captureDiagnostics();
    expect(editor.present).toBe(true);
    expect(editor.isEditable).toBe(true);
    expect(editor.isFocused).toBe(false);
    expect(editor.viewDomMatchesVisiblePrompt).toBe(false);
    expect(editor.docCharCount).toBe("hello world".length);
    // The prompt's actual text must not appear anywhere in the payload.
    expect(JSON.stringify(captureDiagnostics())).not.toContain("hello world");
  });

  test("a destroyed editor is reported as such rather than being queried", () => {
    registerDiagnosticEditor({
      isDestroyed: true,
      get isEditable(): boolean {
        throw new Error("must not be read on a destroyed editor");
      },
    } as never);

    expect(captureDiagnostics().editor).toEqual({
      present: true,
      isDestroyed: true,
    });
  });
});
