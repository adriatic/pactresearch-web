import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_SCRIPT,
  THEME_STORAGE_KEY,
  parseThemeChoice,
  readThemeChoice,
  resolveTheme,
  saveThemeChoice,
} from "@/lib/theme";

// Task D11. The Light / Dark / System choice, and the script that applies
// it before the page is drawn.

type Listener = () => void;

function mockSystem(prefersDark: boolean) {
  const listeners: Listener[] = [];
  const media = {
    matches: prefersDark,
    addEventListener: (_: string, fn: Listener) => listeners.push(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return {
    setDark(dark: boolean) {
      media.matches = dark;
      listeners.forEach((fn) => fn());
    },
  };
}

function runScript() {
  new Function(THEME_SCRIPT)();
}

const theme = () => document.documentElement.getAttribute("data-theme");

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseThemeChoice", () => {
  it("keeps the three choices and turns anything else into light", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("system")).toBe("system");
    expect(parseThemeChoice(null)).toBe("light");
    expect(parseThemeChoice("Dark")).toBe("light");
    expect(parseThemeChoice("")).toBe("light");
  });
});

describe("resolveTheme", () => {
  it("System follows the device; Light and Dark ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("the pre-paint script", () => {
  it("nothing saved: light, even when the device is dark (the iPad case)", () => {
    mockSystem(true);
    runScript();
    expect(theme()).toBe("light");
  });

  it("Dark saved: dark", () => {
    mockSystem(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runScript();
    expect(theme()).toBe("dark");
  });

  it("Light saved on a dark device: light", () => {
    mockSystem(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runScript();
    expect(theme()).toBe("light");
  });

  it("System saved: follows the device, also when it changes later", () => {
    const system = mockSystem(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    runScript();
    expect(theme()).toBe("light");
    system.setDark(true);
    expect(theme()).toBe("dark");
    system.setDark(false);
    expect(theme()).toBe("light");
  });

  it("a stored value it does not know: light", () => {
    mockSystem(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "purple");
    runScript();
    expect(theme()).toBe("light");
  });

  it("never throws, even without matchMedia or with storage refusing", () => {
    vi.stubGlobal("matchMedia", undefined);
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage off");
      });
    expect(runScript).not.toThrow();
    expect(theme()).toBe("light");
    getItem.mockRestore();
  });
});

describe("saveThemeChoice and readThemeChoice", () => {
  it("saves under pact-theme and applies at once", () => {
    mockSystem(false);
    saveThemeChoice("dark");
    expect(window.localStorage.getItem("pact-theme")).toBe("dark");
    expect(theme()).toBe("dark");
    expect(readThemeChoice()).toBe("dark");

    saveThemeChoice("light");
    expect(theme()).toBe("light");
    expect(readThemeChoice()).toBe("light");
  });

  it("System on a dark device applies dark and is read back as System", () => {
    mockSystem(true);
    saveThemeChoice("system");
    expect(theme()).toBe("dark");
    expect(readThemeChoice()).toBe("system");
  });

  it("reads light when nothing is saved", () => {
    expect(readThemeChoice()).toBe("light");
  });
});
