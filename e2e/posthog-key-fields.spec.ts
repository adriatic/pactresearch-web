import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task 81 Stage 2 (Task 72's rule for every key field): a key typed into
// Account -> Keys, shown or hidden, never appears in what PostHog's
// session recorder sends.
//
// This runs the REAL recorder (posthog-js's own lazy-recorder.js, from
// node_modules) in the page, with recording switched on by a local answer
// to PostHog's config request. Every PostHog request is answered here and
// none leaves this machine; the recording uploads are kept and decoded
// (gzip, and gzip again inside, as the recorder sends them).
//
// The page is made to look like a person's Chrome: instrumentation-client
// never starts PostHog under navigator.webdriver, and posthog-js itself
// stays silent for a "HeadlessChrome" browser brand.

const AS_A_PERSON = `
  Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  const brands = [{ brand: "Google Chrome", version: "153" }, { brand: "Chromium", version: "153" }];
  Object.defineProperty(Navigator.prototype, "userAgentData", {
    get: () => ({ brands, mobile: false, platform: "macOS",
      getHighEntropyValues: async () => ({ brands, platform: "macOS" }) }),
  });
`;
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36";

const OPENAI_TYPED = "sk-proj-E2E-RECORDER-OPENAI-zq81";
const ANTHROPIC_TYPED = "sk-ant-E2E-RECORDER-ANTHROPIC-zq81";
// Typed into an ordinary field afterwards: it must be in the recording,
// which proves the recorder was really recording typed text.
const CONTROL_TYPED = "E2E recorder control zq81";

test.use({ userAgent: DESKTOP_CHROME_UA });
test.setTimeout(90_000);

// The recording as text: each upload's $snapshot events, with the
// recorder's own compressed fields unpacked.
function decodeRecording(uploads: Buffer[]): string {
  const unpack = (value: unknown) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString());
    } catch {
      return value;
    }
  };
  const events: unknown[] = [];
  for (const raw of uploads) {
    let text: string;
    try {
      text = gunzipSync(raw).toString("utf8");
    } catch {
      text = raw.toString("utf8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const e of (Array.isArray(parsed) ? parsed : [parsed]) as {
      event?: string;
      properties?: { $snapshot_data?: Record<string, unknown>[] };
    }[]) {
      if (e.event !== "$snapshot") continue;
      for (const snap of e.properties?.$snapshot_data ?? []) {
        const data = snap.data as Record<string, unknown>;
        if (snap.cv && snap.type === 2) snap.data = unpack(data);
        if (snap.cv && snap.type === 3) {
          for (const k of ["adds", "removes", "texts", "attributes"]) {
            if (k in data) data[k] = unpack(data[k]);
          }
        }
        events.push(snap);
      }
    }
  }
  return JSON.stringify(events);
}

async function recordedPage(page: Page, uploads: Buffer[], all: string[]) {
  await page.addInitScript({ content: AS_A_PERSON });
  const recorder = readFileSync(
    "node_modules/posthog-js/dist/lazy-recorder.js",
    "utf8",
  );
  await page.route(/posthog\.com/, async (route) => {
    const url = new URL(route.request().url());
    all.push(url.pathname);
    if (url.pathname.endsWith("/config.js")) {
      return route.fulfill({ contentType: "application/javascript", body: "" });
    }
    if (url.pathname.endsWith("/config")) {
      return route.fulfill({
        json: { sessionRecording: { endpoint: "/s/" } },
      });
    }
    if (url.pathname.startsWith("/flags")) {
      return route.fulfill({
        json: {
          flags: {},
          featureFlags: {},
          sessionRecording: { endpoint: "/s/" },
        },
      });
    }
    if (url.pathname.includes("lazy-recorder")) {
      return route.fulfill({
        contentType: "application/javascript",
        body: recorder,
      });
    }
    const body = route.request().postDataBuffer();
    if (body) uploads.push(body);
    return route.fulfill({ json: { status: 1 } });
  });
}

async function signIn(page: Page, context: BrowserContext) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  );
  const admin = createServiceClient(API_URL, SERVICE_ROLE_KEY);
  const email = `e2e-ph-keys-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "recorder key fields 81!";
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
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
  await client.auth.signInWithPassword({ email, password });
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
  await page.goto("/");
  await expect(page.locator("header[data-switch-ms]")).toBeVisible({
    timeout: 15_000,
  });
}

test("typed keys, shown or hidden, never reach PostHog's recorder; other typing does", async ({
  page,
  context,
}) => {
  const uploads: Buffer[] = [];
  const requests: string[] = [];
  await recordedPage(page, uploads, requests);
  await signIn(page, context);

  // The real recorder was loaded and switched on.
  await expect
    .poll(() => requests.some((p) => p.includes("lazy-recorder")))
    .toBe(true);

  await page.locator("header").getByRole("button", { name: "Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Account" });
  await dialog.getByRole("tab", { name: "Keys" }).click();

  await dialog.getByText("ChatGPT (optional)").click();
  const openAi = dialog.getByRole("group", { name: "OpenAI key" });
  await openAi.getByLabel("OpenAI API key:").pressSequentially(OPENAI_TYPED);
  await openAi.getByRole("button", { name: "Show" }).click();
  await expect(openAi.getByLabel("OpenAI API key:")).toHaveAttribute(
    "type",
    "text",
  );
  await expect(openAi.getByLabel("OpenAI API key:")).toHaveClass(
    /(^|\s)ph-no-capture(\s|$)/,
  );

  const anthropic = dialog.getByLabel("Anthropic API key:");
  await anthropic.pressSequentially(ANTHROPIC_TYPED);
  await dialog.getByRole("button", { name: "Show" }).first().click();
  await expect(anthropic).toHaveAttribute("type", "text");

  // After the keys, ordinary typing that the recorder must keep.
  await dialog.getByRole("tab", { name: "Profile" }).click();
  await dialog.getByLabel("Your name:").fill(CONTROL_TYPED);

  // Wait until the recording holds the control text: everything typed
  // before it has been uploaded by then.
  await expect
    .poll(() => decodeRecording(uploads).includes(CONTROL_TYPED), {
      timeout: 30_000,
    })
    .toBe(true);

  const recording = decodeRecording(uploads);
  const everything = uploads
    .map((b) => {
      try {
        return gunzipSync(b).toString("utf8");
      } catch {
        return b.toString("utf8");
      }
    })
    .join("\n");
  for (const typed of [OPENAI_TYPED, ANTHROPIC_TYPED]) {
    expect(recording).not.toContain(typed);
    expect(everything).not.toContain(typed);
    // Nor any piece of it long enough to matter.
    expect(recording).not.toContain(typed.slice(-12));
  }
  // Both key fields are in the recording only as blocked boxes.
  expect(
    recording.match(/"class":"ph-no-capture"/g)?.length ?? 0,
  ).toBeGreaterThanOrEqual(2);
});
