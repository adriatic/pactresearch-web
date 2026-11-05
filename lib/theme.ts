// Task D11. The Light / Dark / System choice.
//
// Stored in this browser only (localStorage, one key), never in the
// database: a theme is a property of the screen in front of you, the
// iPad and the Mac may well want different ones, and it needs no
// migration. Nothing saved means Light, so nobody's page changes until
// they choose.
//
// The choice is applied as data-theme="light" | "dark" on <html>;
// app/globals.css holds the dark values under :root[data-theme="dark"].
// THEME_SCRIPT applies it before the page is drawn, so a dark choice
// never flashes light; the Account dialog calls saveThemeChoice.

export const THEME_STORAGE_KEY = "pact-theme";

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type Theme = "light" | "dark";

export const THEME_LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

// Anything unknown or missing is Light: the default must never surprise.
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === "dark" || value === "system" ? value : "light";
}

export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): Theme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

export function readThemeChoice(): ThemeChoice {
  try {
    return parseThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage switched off (some private modes): Light.
    return "light";
  }
}

// Saves and applies at once. The pre-paint script's own listeners keep
// System in step with the operating system afterwards.
export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not saved, but still applied for this page.
  }
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute(
    "data-theme",
    resolveTheme(choice, prefersDark),
  );
}

// Runs in <head> before the page is drawn (app/layout.tsx). Plain ES5,
// no imports, and it can never break the page: every path is wrapped.
// It also follows the operating system while System is chosen, and a
// choice made in another tab of the same browser.
export const THEME_SCRIPT = `
(function () {
  try {
    var KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
    var root = document.documentElement;
    var media = window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    function choice() {
      try {
        var v = window.localStorage.getItem(KEY);
        return v === "dark" || v === "system" ? v : "light";
      } catch (e) {
        return "light";
      }
    }
    function apply() {
      try {
        var c = choice();
        var dark = c === "dark" || (c === "system" && !!media && media.matches);
        root.setAttribute("data-theme", dark ? "dark" : "light");
      } catch (e) {}
    }
    apply();
    if (media) {
      if (media.addEventListener) media.addEventListener("change", apply);
      else if (media.addListener) media.addListener(apply);
    }
    window.addEventListener("storage", function (event) {
      if (event.key === KEY || event.key === null) apply();
    });
  } catch (e) {}
})();
`;
