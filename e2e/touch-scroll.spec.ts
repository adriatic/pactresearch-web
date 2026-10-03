import { test, expect, type Page, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 75 follow-up. On Nik's iPad the response panel streamed but could
// not be scrolled with a finger. react-resizable-panels gives every
// Panel inside a vertical Group `touch-action: pan-x`, so a vertical
// touch drag over the transcript (and over the Explorer tree, which is in
// the sidebar's vertical Group) is refused by the browser. A mouse wheel
// ignores touch-action, which is why desktop never showed it.
//
// Chromium rather than the webkit-ipad project: Playwright can only tap
// in WebKit, while Chromium's DevTools protocol synthesizes a real touch
// scroll gesture, and Chromium honours touch-action the same way iPadOS
// WebKit does.

test.use({ hasTouch: true });
test.setTimeout(60_000);

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

// The nearest scrolling ancestor-or-self: the element a finger drag over
// `target` would actually move.
async function scrollTopOfScroller(target: Locator) {
  return target.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node && node.scrollHeight <= node.clientHeight) {
      node = node.parentElement;
    }
    return node ? node.scrollTop : -1;
  });
}

// Starts the drag at the centre of the scroller's own on-screen box --
// the content inside it is taller than the window.
async function touchScrollUp(page: Page, target: Locator) {
  const box = await target.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node && node.scrollHeight <= node.clientHeight) {
      node = node.parentElement;
    }
    const r = node!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    yDistance: -300,
    gestureSourceType: "touch",
    speed: 800,
  });
}

test("a finger drag scrolls the transcript and the Explorer tree", async ({
  page,
  context,
}) => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = getLocalSupabaseStatus();
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-touch-scroll-${suffix}@example.com`;
  const password = "correct horse battery staple 75!";

  const { data: created, error: createUserError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createUserError || !created.user) {
    throw createUserError ?? new Error("failed to create e2e test user");
  }
  const userId = created.user.id;

  // Enough notebooks that the Explorer tree overflows its panel.
  const { data: notebooks, error: notebookError } = await admin
    .from("notebooks")
    .insert(
      Array.from({ length: 30 }, (_, i) => ({
        user_id: userId,
        name: `E2E touch notebook ${String(i).padStart(2, "0")} ${suffix}`,
      })),
    )
    .select();
  expect(notebookError).toBeNull();

  const { data: discussion, error: discussionError } = await admin
    .from("discussions")
    .insert({
      notebook_id: notebooks![0].id,
      user_id: userId,
      name: `E2E touch discussion ${suffix}`,
    })
    .select()
    .single();
  expect(discussionError).toBeNull();

  // Enough history that the transcript overflows its panel.
  const { error: responsesError } = await admin.from("responses").insert(
    Array.from({ length: 10 }, (_, i) => ({
      discussion_id: discussion!.id,
      user_id: userId,
      prompt_text: `Prompt ${i}`,
      response: `${"Lorem ipsum dolor sit amet. ".repeat(150)} (response ${i})`,
      resolved_model: "claude-sonnet-4-6",
    })),
  );
  expect(responsesError).toBeNull();

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
  // The only discussion is opened automatically, history and all.
  await expect(page.getByText("response 9")).toBeAttached({ timeout: 15_000 });

  const transcript = page.locator("main");
  expect(await scrollTopOfScroller(transcript)).toBe(0);
  await touchScrollUp(page, transcript);
  await expect.poll(() => scrollTopOfScroller(transcript)).toBeGreaterThan(100);

  const tree = page.getByRole("tree");
  expect(await scrollTopOfScroller(tree)).toBe(0);
  await touchScrollUp(page, tree);
  await expect.poll(() => scrollTopOfScroller(tree)).toBeGreaterThan(100);
});
