import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task D11. Shared by the theme specs: a seeded, signed-in user, and a
// contrast check that reads the colors the browser actually draws -- the
// real page background, every translucent layer and opacity included --
// rather than assuming white. Task D11g: the app has no theme setting; it
// follows the device, which a spec sets with test.use({ colorScheme }) or
// page.emulateMedia. Not a .spec.ts file, so Playwright does not collect
// it as a test.

export type DeviceScheme = "light" | "dark";

/**
 * The page is drawn in the device's scheme: its own background, and the
 * browser's Canvas system color, which native controls (checkboxes,
 * scrollbars, a dropdown's list) are drawn from. The computed
 * color-scheme itself is "light dark" on every device, so it cannot
 * tell the two apart.
 */
export async function expectPageTheme(page: Page, scheme: DeviceScheme) {
  const background = luminanceOf(await pageBackground(page));
  const canvas = luminanceOf(
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "Canvas";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }),
  );
  if (scheme === "light") {
    expect(background, "page background").toBeGreaterThan(0.9);
    expect(canvas, "native controls (Canvas)").toBeGreaterThan(0.9);
  } else {
    expect(background, "page background").toBeLessThan(0.05);
    expect(canvas, "native controls (Canvas)").toBeLessThan(0.05);
  }
}

export interface Seeded {
  admin: SupabaseClient;
  userId: string;
  notebookId: string;
  discussionId: string;
  notebookName: string;
  discussionName: string;
}

/** A fresh user with one notebook and one discussion, signed in. */
export async function seedSignedIn(
  context: BrowserContext,
  opts: {
    tag: string;
    notebookName?: string;
    discussionName?: string;
    totalTimeMs?: number;
  },
): Promise<Seeded> {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-${opts.tag}-${suffix}@example.com`;
  const password = "theme contrast e2e D11!";
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no user");
  const userId = created.user.id;
  const notebookName =
    opts.notebookName ?? `E2E ${opts.tag} notebook ${suffix}`;
  const discussionName =
    opts.discussionName ?? `E2E ${opts.tag} discussion ${suffix}`;
  const { data: notebook } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  const { data: discussion } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
      total_time_ms: opts.totalTimeMs ?? 0,
    })
    .select()
    .single();
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) =>
        cs.forEach(({ name, value }) => {
          const e = jar.find((c) => c.name === name);
          if (e) e.value = value;
          else jar.push({ name, value });
        }),
    },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;
  await context.addCookies(
    jar.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );
  return {
    admin,
    userId,
    notebookId: notebook!.id as string,
    discussionId: discussion!.id as string,
    notebookName,
    discussionName,
  };
}

/** Opens the workspace and the seeded discussion. */
export async function openSeededDiscussion(page: Page, seeded: Seeded) {
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  const row = page.getByRole("treeitem", {
    name: seeded.notebookName,
    exact: true,
  });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.locator("h3").click();
  }
  const discussionRow = page.getByRole("treeitem", {
    name: seeded.discussionName,
    exact: true,
  });
  await discussionRow.click();
  await expect(
    page.getByRole("group", { name: "Active discussion" }),
  ).toContainText(seeded.discussionName, { timeout: 15_000 });
}

export interface ContrastItem {
  kind: "text" | "placeholder" | "mark";
  text: string;
  fg: string;
  bg: string;
  ratio: number;
}

/**
 * Every piece of visible text inside `scope` (and each element marked
 * data-contrast-mark, measured as a shape against what is behind it),
 * with the contrast the browser actually draws.
 *
 * Text: each element with its own text, an input's value or
 * placeholder, and the composer's empty-line placeholder. Disabled
 * controls are left out (WCAG exempts them; they are drawn at half
 * opacity on purpose). The background is found by walking up the
 * element's ancestors and laying each translucent background over the
 * next, down to the first opaque one or the page itself.
 */
export async function contrastSweep(scope: Locator): Promise<ContrastItem[]> {
  return scope.evaluate((root) => {
    type RGBA = [number, number, number, number];
    // Any CSS color the browser computes: rgb()/rgba() directly, others
    // (Tailwind's placeholder is oklab(... / 0.5)) drawn on a 1x1 canvas
    // and read back as sRGB.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    function parse(value: string): RGBA {
      const m = value.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (a === 0 && value !== "transparent" && !/\/\s*0\)$/.test(value))
        throw new Error(`unreadable color: ${value}`);
      return [r, g, b, a / 255];
    }
    function over(top: RGBA, under: RGBA): RGBA {
      const a = top[3];
      return [
        top[0] * a + under[0] * (1 - a),
        top[1] * a + under[1] * (1 - a),
        top[2] * a + under[2] * (1 - a),
        1,
      ];
    }
    function lum(c: RGBA) {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function ratio(a: RGBA, b: RGBA) {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }
    const hex = (c: RGBA) =>
      "#" +
      c
        .slice(0, 3)
        .map((v) => Math.round(v).toString(16).padStart(2, "0"))
        .join("");
    function backdrop(start: Element | null): RGBA {
      const layers: RGBA[] = [];
      for (let e = start; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
      }
      let base: RGBA = [255, 255, 255, 1];
      if (!layers.length || layers[layers.length - 1][3] < 1) {
        // Nothing opaque above: the canvas, which takes the page's
        // background (body's, or html's).
        for (const e of [document.body, document.documentElement]) {
          const bg = parse(getComputedStyle(e).backgroundColor);
          if (bg[3] > 0) {
            base = over(bg, base);
            break;
          }
        }
      }
      return layers.reduceRight((acc, layer) => over(layer, acc), base);
    }
    function opacity(el: Element) {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement)
        o *= Number(getComputedStyle(e).opacity);
      return o;
    }
    function visible(el: Element) {
      const s = getComputedStyle(el);
      return (
        el.getClientRects().length > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        opacity(el) > 0
      );
    }
    const disabled = (el: Element) =>
      !!el.closest(":disabled, [aria-disabled='true']");

    const out: {
      kind: "text" | "placeholder" | "mark";
      text: string;
      fg: string;
      bg: string;
      ratio: number;
    }[] = [];
    function record(
      kind: "text" | "placeholder" | "mark",
      text: string,
      el: Element,
      color: string,
      bgFrom: Element | null,
    ) {
      const back = backdrop(bgFrom);
      const fgRaw = parse(color);
      const fg = over(
        [fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity(el)],
        back,
      );
      out.push({
        kind,
        text: text.replace(/\s+/g, " ").trim().slice(0, 60),
        fg: hex(fg),
        bg: hex(back),
        ratio: Math.round(ratio(fg, back) * 100) / 100,
      });
    }

    const all = [root, ...root.querySelectorAll("*")];
    for (const el of all) {
      if (!visible(el) || disabled(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "svg") continue;
      if (el.hasAttribute("data-contrast-mark")) {
        record(
          "mark",
          el.getAttribute("data-contrast-mark") || "mark",
          el,
          getComputedStyle(el).backgroundColor,
          el.parentElement,
        );
        continue;
      }
      if (tag === "input" || tag === "textarea") {
        const field = el as HTMLInputElement;
        if (
          ["checkbox", "radio", "file", "range", "color", "hidden"].includes(
            field.type,
          )
        )
          continue;
        if (field.value)
          record("text", field.value, el, getComputedStyle(el).color, el);
        else if (field.placeholder)
          record(
            "placeholder",
            field.placeholder,
            el,
            getComputedStyle(el, "::placeholder").color,
            el,
          );
        continue;
      }
      if (el.matches(".tiptap p.is-editor-empty:first-child")) {
        const before = getComputedStyle(el, "::before");
        const content = el.getAttribute("data-placeholder");
        if (content && before.content !== "none")
          record("placeholder", content, el, before.color, el);
      }
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (ownText) record("text", ownText, el, getComputedStyle(el).color, el);
    }
    return out;
  });
}

/** The page's own background color as drawn (body, else html, else white). */
export async function pageBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const e of [document.body, document.documentElement]) {
      const bg = getComputedStyle(e).backgroundColor;
      const alpha = bg.match(/rgba\([^)]*,\s*([\d.]+)\)/);
      if (!alpha || Number(alpha[1]) > 0) return bg;
    }
    return "rgb(255, 255, 255)";
  });
}

/** Relative luminance of an "rgb(...)" string: 0 is black, 1 is white. */
export function luminanceOf(rgb: string): number {
  const [r, g, b] = rgb
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const MIN_CONTRAST = 4.5;
