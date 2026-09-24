import type { Editor } from "@tiptap/core";

// Task 39: the permanent, on-demand version of task 36's throwaway
// bookmarklets. Those were the only instrumentation that could actually
// see that bug -- automated tests couldn't reproduce it, and adding
// console logging risked perturbing the timing enough to hide it. This
// module is the capture half; app/DiagnosticCapture.tsx is the UI.
//
// Two hard design rules follow from what task 36 taught:
//
// 1. Capturing must never throw. It runs precisely when the app is
//    already misbehaving, so every section below is individually
//    guarded -- a section that fails records its own error string rather
//    than taking the whole capture down with it.
//
// 2. It must not perturb what it measures. Nothing here installs a
//    listener that can interfere: the only always-on listener (pointer
//    tracking, installed by the inline script in app/layout.tsx) is
//    registered `passive: true` on the bubble phase, so the browser
//    itself guarantees it cannot preventDefault. That matters because
//    task 36 spent a long stretch investigating whether exactly such a
//    handler was swallowing clicks.

// How many console entries the ring buffer keeps, and how long any single
// stringified argument may be. Both bounded so a chatty page can't grow
// this without limit.
export const CONSOLE_BUFFER_LIMIT = 200;
export const CONSOLE_ARG_MAX_CHARS = 500;

// How far up the ancestor chain geometry is walked. Task 36's own
// bookmarklets used 8-10; the bug (a wrapper collapsing to its content
// height) sat 3 levels up from the editor node.
const ANCESTOR_DEPTH = 8;

// Computed-style properties worth having for a layout bug. Deliberately
// narrow: a full getComputedStyle dump is hundreds of properties per
// element and buries the signal.
const LAYOUT_STYLE_PROPS = [
  "display",
  "position",
  "height",
  "minHeight",
  "maxHeight",
  "width",
  "overflow",
  "overflowY",
  "flexBasis",
  "flexGrow",
  "flexShrink",
  "flexDirection",
  "boxSizing",
  "zIndex",
  "pointerEvents",
  "visibility",
  "opacity",
] as const;

export interface ElementSnapshot {
  tag: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  role?: string;
  contentEditable?: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
}

export interface ConsoleEntry {
  t: number;
  level: string;
  args: string[];
}

export interface DiagnosticCapture {
  capturedAt: string;
  url: string;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  activeElement: ElementSnapshot | null;
  activeElementIsBody: boolean;
  hoveredElement: ElementSnapshot | null;
  lastPointerDown: {
    x: number;
    y: number;
    tSincePageLoadMs: number;
    hitTest: ElementSnapshot | null;
  } | null;
  editor: {
    present: boolean;
    isEditable?: boolean;
    isFocused?: boolean;
    isEmpty?: boolean;
    isDestroyed?: boolean;
    // Task 36's decisive check: whether the live editor instance's own
    // DOM node is the one actually on screen, or an orphan left behind.
    viewDomMatchesVisiblePrompt?: boolean;
    docCharCount?: number;
  };
  focusChain: ElementSnapshot[];
  pointerChain: ElementSnapshot[];
  composerChain: ElementSnapshot[];
  console: ConsoleEntry[];
  navTiming: Record<string, number> | null;
  resourceTiming: {
    name: string;
    startTime: number;
    duration: number;
    responseEnd: number;
  }[];
  errors: Record<string, string>;
}

// ---------------------------------------------------------------------
// Editor registry
//
// Tiptap's isEditable/isFocused live on the instance, not the DOM, so
// they can't be read from markup alone -- and they were exactly what
// ruled out the "stuck editable flag" theory in task 36. Composer
// registers its instance here on mount and clears it on unmount, so a
// capture taken while no composer is mounted simply reports
// `present: false` rather than failing.
// ---------------------------------------------------------------------
let registeredEditor: Editor | null = null;

export function registerDiagnosticEditor(editor: Editor | null): void {
  registeredEditor = editor;
}

/** Test seam only -- lets unit tests assert the "no editor" path. */
export function getRegisteredDiagnosticEditor(): Editor | null {
  return registeredEditor;
}

// ---------------------------------------------------------------------
// Window globals written by app/layout.tsx's inline script, which runs
// before hydration so it can catch hydration warnings a
// normally-timed listener would miss entirely.
// ---------------------------------------------------------------------
interface DiagWindow {
  __pactDiagConsole?: ConsoleEntry[];
  __pactDiagPointer?: { x: number | null; y: number | null; t: number | null };
}

function diagWindow(): DiagWindow {
  return window as unknown as DiagWindow;
}

function safe<T>(
  errors: Record<string, string>,
  key: string,
  fn: () => T,
  fallback: T,
): T {
  try {
    return fn();
  } catch (error) {
    errors[key] = error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

export function describeElement(el: Element | null): ElementSnapshot | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of LAYOUT_STYLE_PROPS) {
    styles[prop] = computed[prop as unknown as number] as unknown as string;
  }
  const html = el as HTMLElement;
  return {
    tag: el.tagName,
    id: el.id || undefined,
    className:
      typeof el.className === "string" ? el.className || undefined : undefined,
    ariaLabel: el.getAttribute("aria-label") ?? undefined,
    role: el.getAttribute("role") ?? undefined,
    contentEditable: html.isContentEditable ? "true" : undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
    styles,
  };
}

export function ancestorChain(
  el: Element | null,
  depth = ANCESTOR_DEPTH,
): ElementSnapshot[] {
  const chain: ElementSnapshot[] = [];
  let node: Element | null = el;
  for (let i = 0; i < depth && node; i++) {
    const snapshot = describeElement(node);
    if (snapshot) chain.push(snapshot);
    node = node.parentElement;
  }
  return chain;
}

/** The deepest element currently under the pointer, or null. */
function deepestHovered(): Element | null {
  const hovered = document.querySelectorAll(":hover");
  return hovered.length > 0 ? hovered[hovered.length - 1] : null;
}

export function captureDiagnostics(): DiagnosticCapture {
  const errors: Record<string, string> = {};

  const pointer = safe(
    errors,
    "pointer",
    () => diagWindow().__pactDiagPointer ?? null,
    null,
  );
  const pointerHit =
    pointer && pointer.x !== null && pointer.y !== null
      ? safe(
          errors,
          "pointerHitTest",
          () => document.elementFromPoint(pointer.x!, pointer.y!),
          null,
        )
      : null;

  const activeElement = safe(
    errors,
    "activeElement",
    () => document.activeElement,
    null,
  );
  const promptEl = safe(
    errors,
    "promptEl",
    () => document.querySelector('[aria-label="Prompt"]'),
    null,
  );

  return {
    capturedAt: new Date().toISOString(),
    url: safe(errors, "url", () => window.location.href, ""),
    userAgent: safe(errors, "userAgent", () => navigator.userAgent, ""),
    viewport: safe(
      errors,
      "viewport",
      () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
      { width: 0, height: 0, devicePixelRatio: 0 },
    ),

    activeElement: safe(
      errors,
      "activeElementSnapshot",
      () => describeElement(activeElement),
      null,
    ),
    // Broken-focus bugs read as "activeElement is BODY" -- the single
    // most telling line in task 36's decisive capture, so it is called
    // out rather than left to be inferred from the snapshot.
    activeElementIsBody: safe(
      errors,
      "activeElementIsBody",
      () => activeElement === document.body,
      false,
    ),
    hoveredElement: safe(
      errors,
      "hovered",
      () => describeElement(deepestHovered()),
      null,
    ),

    lastPointerDown:
      pointer && pointer.x !== null && pointer.y !== null
        ? {
            x: pointer.x,
            y: pointer.y,
            tSincePageLoadMs: pointer.t ?? 0,
            hitTest: safe(
              errors,
              "pointerHitSnapshot",
              () => describeElement(pointerHit),
              null,
            ),
          }
        : null,

    editor: safe(
      errors,
      "editor",
      () => {
        const editor = registeredEditor;
        if (!editor) return { present: false };
        if (editor.isDestroyed) return { present: true, isDestroyed: true };
        return {
          present: true,
          isDestroyed: false,
          isEditable: editor.isEditable,
          isFocused: editor.isFocused,
          isEmpty: editor.isEmpty,
          viewDomMatchesVisiblePrompt: editor.view.dom === promptEl,
          // A count, deliberately not the text itself: enough to tell
          // "empty vs has content" apart without putting the user's
          // prompt into a blob meant for pasting into bug reports.
          docCharCount: editor.getText().length,
        };
      },
      { present: false },
    ),

    focusChain: safe(
      errors,
      "focusChain",
      () => ancestorChain(activeElement),
      [],
    ),
    pointerChain: safe(
      errors,
      "pointerChain",
      () => ancestorChain(pointerHit),
      [],
    ),
    // Always captured regardless of focus: the composer is this app's
    // core surface and the subject of every layout bug so far.
    composerChain: safe(
      errors,
      "composerChain",
      () => ancestorChain(promptEl),
      [],
    ),

    console: safe(
      errors,
      "console",
      () => (diagWindow().__pactDiagConsole ?? []).slice(-CONSOLE_BUFFER_LIMIT),
      [],
    ),

    navTiming: safe(
      errors,
      "navTiming",
      () => {
        const nav = performance.getEntriesByType("navigation")[0] as
          PerformanceNavigationTiming | undefined;
        if (!nav) return null;
        return {
          domInteractive: Math.round(nav.domInteractive),
          domContentLoadedEventEnd: Math.round(nav.domContentLoadedEventEnd),
          loadEventEnd: Math.round(nav.loadEventEnd),
          responseEnd: Math.round(nav.responseEnd),
        };
      },
      null,
    ),

    resourceTiming: safe(
      errors,
      "resourceTiming",
      () =>
        performance
          .getEntriesByType("resource")
          .filter((r) => /\.(css|js|woff2?)(\?|$)|_next\/static/.test(r.name))
          .map((r) => ({
            name: r.name.split("/").pop() ?? r.name,
            startTime: Math.round(r.startTime),
            duration: Math.round(r.duration),
            responseEnd: Math.round(
              (r as PerformanceResourceTiming).responseEnd,
            ),
          })),
      [],
    ),

    errors,
  };
}
