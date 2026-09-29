import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 64. Verifies a response containing LaTeX renders as typeset math
// rather than raw source. Same seeding pattern as markdown-rendering.spec
// (and the same reasoning: the history view and the live-streaming view
// share MarkdownResponse, so exercising history is evidence for both).
//
// The unit tests already cover which delimiters parse and what the DOM
// looks like. What only a real browser can show is the half of this
// feature that jsdom cannot: that "katex/dist/katex.min.css" is actually
// served and applied by the Next build, and that its webfonts resolve.
// Without the stylesheet the same markup renders as a heap of unstyled
// spans -- technically "math", unreadable in practice. So the assertions
// here are about applied styling, not about parsing.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

test.setTimeout(60_000);

test("a response containing LaTeX renders as typeset math with KaTeX styling applied", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-math-${suffix}@example.com`;
  const password = "correct horse battery staple 11!";
  const notebookName = `E2E math notebook ${suffix}`;
  const discussionName = `E2E math discussion ${suffix}`;

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  const { data: notebook, error: notebookError } = await admin
    .from("notebooks")
    .insert({ user_id: userId, name: notebookName })
    .select()
    .single();
  expect(notebookError).toBeNull();

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebook!.id,
      user_id: userId,
      name: discussionName,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  // Both delimiter conventions, and a currency amount in the same text,
  // because the whole point of the configuration is that these coexist.
  const mathResponse = [
    "The Lagrangian of a simple pendulum is:",
    "",
    "$$",
    "L = \\frac{1}{2} m \\ell^2 \\dot{\\theta}^2 + m g \\ell \\cos\\theta",
    "$$",
    "",
    "Since \\(E = mc^2\\), the rig costs $50 and $60 to build.",
  ].join("\n");

  const { error: responseError } = await admin.from("responses").insert({
    discussion_id: discussion!.id,
    user_id: userId,
    prompt_text: "Give me the Lagrangian of a pendulum",
    response: mathResponse,
    resolved_model: "claude-sonnet-4-6",
  });
  expect(responseError).toBeNull();

  const capturedCookies: { name: string; value: string }[] = [];
  const jarClient = createServerClient(API_URL, ANON_KEY, {
    cookies: {
      getAll: () => capturedCookies,
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => {
          const existing = capturedCookies.find((c) => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            capturedCookies.push({ name, value });
          }
        });
      },
    },
  });
  const { error: signInError } = await jarClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;

  await context.addCookies(
    capturedCookies.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "Lax" as const,
    })),
  );

  await page.goto("/");

  // Both equations typeset: the display block and the inline one.
  const katex = page.locator(".katex");
  await expect(katex).toHaveCount(2);
  await expect(page.locator(".katex-display")).toHaveCount(1);

  // The stylesheet is present and applied. KaTeX sets its own webfont on
  // .katex; if the CSS import were dropped or failed to serve, this would
  // fall back to the page font and the math would be unreadable.
  const fontFamily = await katex
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fontFamily).toContain("KaTeX_Main");

  // And the font file itself resolves -- a 404 on the woff2 leaves the
  // rule applied but the glyphs wrong, which the check above cannot see.
  //
  // Deliberately NOT document.fonts.check("16px KaTeX_Main"): that
  // returns true for a family that does not exist at all (measured --
  // it answers true for "Definitely_Not_A_Real_Font_XYZ"), because the
  // system fallback always counts as available. Inspecting the actual
  // FontFace entries is the assertion that can fail.
  const fontStatuses = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.family.replace(/"/g, "").startsWith("KaTeX_Main"))
      .map((f) => f.status);
  });
  expect(fontStatuses.length).toBeGreaterThan(0);
  expect(fontStatuses).toContain("loaded");

  const bodyText = await page.locator("body").innerText();
  // Raw source gone...
  expect(bodyText).not.toContain("\\frac");
  expect(bodyText).not.toContain("\\dot");
  expect(bodyText).not.toContain("\\(E = mc^2\\)");
  // ...but the money is still money.
  expect(bodyText).toContain("$50 and $60");
});
