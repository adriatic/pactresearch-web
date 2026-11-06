import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Task D11g (Nik, 2026-11-05). pact-web has no theme setting: the page
// follows the device through CSS alone. These checks read the source, so
// a theme choice, a stored key or a data-theme switch cannot come back
// unnoticed. The browser side is in e2e/theme-follow-device.spec.ts.

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|css)$/.test(name) ? [path] : [];
  });
}

function variableNames(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();
}

describe("the page follows the device", () => {
  it("no app code reads or writes pact-theme, or sets data-theme", () => {
    const files = ["app", "lib", "utils"].flatMap((d) =>
      sourceFiles(join(ROOT, d)),
    );
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) =>
      /pact-theme|data-theme|localStorage[^\n]*theme/i.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the dark values sit under prefers-color-scheme: dark, one for every light variable", () => {
    const rootStart = css.indexOf(":root {");
    const light = css.slice(rootStart, css.indexOf("\n}", rootStart));
    const darkStart = css.indexOf("@media (prefers-color-scheme: dark) {");
    expect(darkStart).toBeGreaterThan(rootStart);
    const dark = css.slice(darkStart, css.indexOf("\n}", darkStart));
    expect(dark).toContain(":root {");

    // Tailwind's own --color-* and --font-* aliases point at these
    // variables and need no dark value of their own.
    const lightNames = variableNames(light).filter(
      (n) => !n.startsWith("--color-") && !n.startsWith("--font-"),
    );
    expect(variableNames(dark)).toEqual(lightNames);
    expect(lightNames.length).toBe(33);
  });

  it("native controls follow the device: color-scheme light dark", () => {
    const rootStart = css.indexOf(":root {");
    const light = css.slice(rootStart, css.indexOf("\n}", rootStart));
    expect(light).toMatch(/color-scheme:\s*light dark;/);
  });

  it("the dropdown arrow has a dark variant under the same media query", () => {
    const blocks = css.split("@media (prefers-color-scheme: dark) {").slice(1);
    expect(
      blocks.some(
        (b) => b.includes("select.toolbar-select") && b.includes("%23d4e0ef"),
      ),
    ).toBe(true);
  });
});
