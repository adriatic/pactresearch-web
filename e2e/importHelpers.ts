import { expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Shared by the Task 79 import specs (pact-import-multi, ipad-import-multi).

const FIXTURES = join(__dirname, "..", "tools", "pact-convert", "fixtures");
export const fixtureText = (name: string) =>
  readFileSync(join(FIXTURES, name), "utf8");

/** A fresh user, signed in, on the workspace. Optionally with a discussion open. */
export async function signIn(
  page: Page,
  context: BrowserContext,
  opts: { withDiscussion?: boolean } = {},
): Promise<{ admin: SupabaseClient; userId: string }> {
  const status = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf-8",
    }),
  ) as { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  const admin = createServiceClient(status.API_URL, status.SERVICE_ROLE_KEY);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-import-${suffix}@example.com`;
  const password = "correct horse battery staple 79!";
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error("no user");
  const userId = created.user.id;
  if (opts.withDiscussion) {
    const { data: nb } = await admin
      .from("notebooks")
      .insert({ user_id: userId, name: `E2E drop notebook ${suffix}` })
      .select()
      .single();
    await admin.from("discussions").insert({
      notebook_id: nb!.id,
      user_id: userId,
      name: `E2E drop discussion ${suffix}`,
    });
  }
  const jar: { name: string; value: string }[] = [];
  const client = createServerClient(status.API_URL, status.ANON_KEY, {
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
  await page.goto("/");
  await page.locator("header[data-switch-ms]").waitFor({ timeout: 15_000 });
  return { admin, userId };
}

export async function notebookCount(admin: SupabaseClient, userId: string) {
  const { count } = await admin
    .from("notebooks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count ?? 0;
}

export const importStatus = (page: Page) =>
  page.locator("header [data-import-status]");

/**
 * Dispatches a real drag event carrying real Files, the way a drop from
 * Finder arrives. `selector` picks the target element (default: body).
 */
export async function dragFiles(
  page: Page,
  type: "dragover" | "drop",
  files: { name: string; text: string; mime?: string }[],
  selector = "body",
) {
  await page.evaluate(
    ({ type, files, selector }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        dt.items.add(new File([f.text], f.name, { type: f.mime ?? "" }));
      }
      const target = document.querySelector(selector)!;
      const r = (target as HTMLElement).getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: r.left + 10,
          clientY: r.top + 10,
        }),
      );
    },
    { type, files, selector },
  );
}

export async function expectSummary(page: Page, text: string | RegExp) {
  await expect(importStatus(page)).toContainText(text, { timeout: 15_000 });
}
