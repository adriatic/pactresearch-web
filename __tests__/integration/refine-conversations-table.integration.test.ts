import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// Task D17c. The refine_conversations table from
// 20261106120000_refine_conversations.sql, on the LOCAL database only:
// who can read and write a row (RLS), the defaults, the cascades, the
// constraints and one row per notebook. The service-role client is the
// local Docker stack's own (from `supabase status`), used only to set up
// users and to look past RLS when checking what is really stored.

interface LocalSupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function runLocalSql(sql: string): void {
  execFileSync("npx", ["supabase", "db", "query", "--local", sql], {
    stdio: "inherit",
  });
}

function getLocalSupabaseStatus(): LocalSupabaseStatus {
  const output = execFileSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf-8",
  });
  return JSON.parse(output) as LocalSupabaseStatus;
}

const TABLE = "refine_conversations";
const RLS_DENIED = "42501";
const CHECK_FAILED = "23514";
const UNIQUE_CONFLICT = "23505";

type Message = { role: string; content: string; provider?: string };

// n alternating messages, user first; assistant replies carry a provider
// when withProvider is set.
function conversation(n: number, withProvider = true): Message[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: `question ${i}` }
      : withProvider
        ? { role: "assistant", content: `reply ${i}`, provider: "anthropic" }
        : { role: "assistant", content: `reply ${i}` },
  );
}

// One user message whose JSON, as Postgres prints jsonb
// ([{"role": "user", "content": "xxx"}]), is exactly `bytes` long. ASCII
// only, so characters are bytes.
function messagesOfJsonSize(bytes: number): Message[] {
  const empty = '[{"role": "user", "content": ""}]'.length;
  return [{ role: "user", content: "x".repeat(bytes - empty) }];
}

describe("refine_conversations (local database)", () => {
  let API_URL: string;
  let ANON_KEY: string;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let a: { userId: string; client: SupabaseClient; notebookId: string };
  let b: { userId: string; client: SupabaseClient; notebookId: string };

  beforeAll(async () => {
    // A known-clean local database with every migration applied, this
    // one included (files run one at a time).
    execFileSync("npx", ["supabase", "db", "reset"], { stdio: "inherit" });

    // The older tables' grants, as the other integration files add them
    // locally. Not refine_conversations: its grant is in the migration,
    // and this file proves it is enough.
    runLocalSql(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebooks " +
        "TO anon, authenticated, service_role;",
    );

    const status = getLocalSupabaseStatus();
    API_URL = status.API_URL;
    ANON_KEY = status.ANON_KEY;
    admin = createServiceClient(API_URL, status.SERVICE_ROLE_KEY);
    anon = createServiceClient(API_URL, ANON_KEY, {
      auth: { persistSession: false },
    });

    a = await userWithNotebook("a");
    b = await userWithNotebook("b");
  }, 120000);

  async function createSignedInUser(tag: string) {
    const email = `refine-conv-${tag}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.com`;
    const password = "correct horse battery staple 3!";
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("no user");

    const cookies: { name: string; value: string }[] = [];
    const client = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll: () => cookies,
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => {
            const existing = cookies.find((c) => c.name === name);
            if (existing) existing.value = value;
            else cookies.push({ name, value });
          });
        },
      },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    return { userId: created.user.id, client };
  }

  async function newNotebook(client: SupabaseClient, userId: string) {
    const { data, error } = await client
      .from("notebooks")
      .insert({ user_id: userId, name: "Notebook" })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("no notebook");
    return data.id as string;
  }

  async function userWithNotebook(tag: string) {
    const user = await createSignedInUser(tag);
    return { ...user, notebookId: await newNotebook(user.client, user.userId) };
  }

  async function storedRow(notebookId: string) {
    const { data, error } = await admin
      .from(TABLE)
      .select("*")
      .eq("notebook_id", notebookId)
      .maybeSingle();
    expect(error).toBeNull();
    return data as {
      notebook_id: string;
      user_id: string;
      messages: Message[];
      updated_at: string;
    } | null;
  }

  describe("the owner", () => {
    test("inserts, reads, updates and deletes the row for their notebook", async () => {
      const notebookId = await newNotebook(a.client, a.userId);

      const { data: inserted, error: insertError } = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages: conversation(1) })
        .select()
        .single();
      expect(insertError).toBeNull();
      expect(inserted.messages).toEqual(conversation(1));

      const { data: read, error: readError } = await a.client
        .from(TABLE)
        .select("messages")
        .eq("notebook_id", notebookId);
      expect(readError).toBeNull();
      expect(read).toEqual([{ messages: conversation(1) }]);

      const { data: updated, error: updateError } = await a.client
        .from(TABLE)
        .update({ messages: conversation(3) })
        .eq("notebook_id", notebookId)
        .select();
      expect(updateError).toBeNull();
      expect(updated).toHaveLength(1);
      expect((await storedRow(notebookId))?.messages).toEqual(conversation(3));

      const { data: deleted, error: deleteError } = await a.client
        .from(TABLE)
        .delete()
        .eq("notebook_id", notebookId)
        .select();
      expect(deleteError).toBeNull();
      expect(deleted).toHaveLength(1);
      expect(await storedRow(notebookId)).toBeNull();
    });

    test("user_id defaults to the signed-in user; messages and updated_at have defaults", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      const before = Date.now();
      const { error } = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId });
      expect(error).toBeNull();

      const row = await storedRow(notebookId);
      expect(row?.user_id).toBe(a.userId);
      expect(row?.messages).toEqual([]);
      expect(Date.parse(row!.updated_at)).toBeGreaterThan(before - 60000);
    });

    test("inserting a row with another user's id is refused", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      const { error } = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, user_id: b.userId });
      expect(error?.code).toBe(RLS_DENIED);
      expect(await storedRow(notebookId)).toBeNull();
    });

    test("changing the row's user_id to another user is refused", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      await a.client.from(TABLE).insert({ notebook_id: notebookId });
      const { error } = await a.client
        .from(TABLE)
        .update({ user_id: b.userId })
        .eq("notebook_id", notebookId);
      expect(error?.code).toBe(RLS_DENIED);
      expect((await storedRow(notebookId))?.user_id).toBe(a.userId);
    });
  });

  describe("another user", () => {
    let aRowNotebook: string;

    beforeAll(async () => {
      aRowNotebook = a.notebookId;
      const { error } = await a.client
        .from(TABLE)
        .insert({ notebook_id: aRowNotebook, messages: conversation(2) });
      expect(error).toBeNull();
    });

    test("B reads nothing of A's", async () => {
      const { data, error } = await b.client
        .from(TABLE)
        .select("*")
        .eq("notebook_id", aRowNotebook);
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: all } = await b.client.from(TABLE).select("notebook_id");
      expect(all?.map((r) => r.notebook_id)).not.toContain(aRowNotebook);
    });

    test("B changes nothing of A's", async () => {
      const { data, error } = await b.client
        .from(TABLE)
        .update({ messages: [] })
        .eq("notebook_id", aRowNotebook)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect((await storedRow(aRowNotebook))?.messages).toEqual(
        conversation(2),
      );
    });

    test("B deletes nothing of A's", async () => {
      const { data, error } = await b.client
        .from(TABLE)
        .delete()
        .eq("notebook_id", aRowNotebook)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(await storedRow(aRowNotebook)).not.toBeNull();
    });

    test("B cannot insert a row for A's notebook (with check), even as B", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      const { error } = await b.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages: conversation(1) });
      expect(error?.code).toBe(RLS_DENIED);
      expect(await storedRow(notebookId)).toBeNull();
    });

    test("B cannot take over A's existing row with an upsert", async () => {
      const { error } = await b.client
        .from(TABLE)
        .upsert({ notebook_id: aRowNotebook, messages: [] });
      expect(error).not.toBeNull();
      expect((await storedRow(aRowNotebook))?.user_id).toBe(a.userId);
      expect((await storedRow(aRowNotebook))?.messages).toEqual(
        conversation(2),
      );
    });

    test("nobody can insert a row for a notebook that does not exist", async () => {
      const missing = "00000000-0000-4000-8000-000000000000";
      const { error } = await b.client
        .from(TABLE)
        .insert({ notebook_id: missing });
      expect(error?.code).toBe(RLS_DENIED);
      expect(await storedRow(missing)).toBeNull();
    });

    test("anon reads nothing and writes nothing", async () => {
      const { data, error } = await anon.from(TABLE).select("*");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const notebookId = await newNotebook(a.client, a.userId);
      const { error: insertError } = await anon
        .from(TABLE)
        .insert({ notebook_id: notebookId, user_id: a.userId });
      expect(insertError?.code).toBe(RLS_DENIED);
      expect(await storedRow(notebookId)).toBeNull();

      const { data: updated } = await anon
        .from(TABLE)
        .update({ messages: [] })
        .eq("notebook_id", aRowNotebook)
        .select();
      expect(updated ?? []).toEqual([]);
      const { data: deleted } = await anon
        .from(TABLE)
        .delete()
        .eq("notebook_id", aRowNotebook)
        .select();
      expect(deleted ?? []).toEqual([]);
      expect((await storedRow(aRowNotebook))?.messages).toEqual(
        conversation(2),
      );
    });
  });

  describe("cascades", () => {
    test("deleting the notebook deletes its row", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      await a.client.from(TABLE).insert({ notebook_id: notebookId });
      expect(await storedRow(notebookId)).not.toBeNull();

      const { error } = await a.client
        .from("notebooks")
        .delete()
        .eq("id", notebookId);
      expect(error).toBeNull();
      expect(await storedRow(notebookId)).toBeNull();
    });

    test("deleting the user deletes the row (through user_id itself)", async () => {
      // A row whose user_id is a different user from the notebook's owner
      // can only be written past RLS. It isolates the user_id cascade
      // from the notebook cascade: the notebook stays, the row goes.
      const owner = await userWithNotebook("owner");
      const other = await createSignedInUser("other");
      const { error: seedError } = await admin
        .from(TABLE)
        .insert({ notebook_id: owner.notebookId, user_id: other.userId });
      expect(seedError).toBeNull();

      const { error } = await admin.auth.admin.deleteUser(other.userId);
      expect(error).toBeNull();
      expect(await storedRow(owner.notebookId)).toBeNull();
      const { data: notebook } = await admin
        .from("notebooks")
        .select("id")
        .eq("id", owner.notebookId)
        .maybeSingle();
      expect(notebook).not.toBeNull();
    });

    test("deleting the user who owns notebook and row deletes the row", async () => {
      const user = await userWithNotebook("leaver");
      await user.client
        .from(TABLE)
        .insert({ notebook_id: user.notebookId, messages: conversation(2) });
      expect(await storedRow(user.notebookId)).not.toBeNull();

      const { error } = await admin.auth.admin.deleteUser(user.userId);
      expect(error).toBeNull();
      expect(await storedRow(user.notebookId)).toBeNull();
    });
  });

  describe("constraints", () => {
    async function insertMessages(messages: unknown) {
      const notebookId = await newNotebook(a.client, a.userId);
      const { error } = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages });
      return { error, notebookId };
    }

    test.each([
      ["an object", { role: "user", content: "hi" }],
      ["a string", "hi"],
      ["a number", 5],
      ["JSON null", null],
    ])("messages that is %s is refused", async (_name, messages) => {
      const { error, notebookId } = await insertMessages(messages);
      expect(error).not.toBeNull();
      expect(await storedRow(notebookId)).toBeNull();
    });

    test("40 messages are accepted, 41 refused", async () => {
      const at = await insertMessages(conversation(40));
      expect(at.error).toBeNull();
      expect((await storedRow(at.notebookId))?.messages).toHaveLength(40);

      const over = await insertMessages(conversation(41));
      expect(over.error?.code).toBe(CHECK_FAILED);
      expect(over.error?.message).toContain(
        "refine_conversations_message_count",
      );
      expect(await storedRow(over.notebookId)).toBeNull();
    });

    test("JSON of 262,144 bytes is accepted, 262,145 refused", async () => {
      const at = await insertMessages(messagesOfJsonSize(262144));
      expect(at.error).toBeNull();
      expect(await storedRow(at.notebookId)).not.toBeNull();

      const over = await insertMessages(messagesOfJsonSize(262145));
      expect(over.error?.code).toBe(CHECK_FAILED);
      expect(over.error?.message).toContain("refine_conversations_size");
      expect(await storedRow(over.notebookId)).toBeNull();
    });

    test("assistant messages with and without a provider are both accepted", async () => {
      const mixed = [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", provider: "openai" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ];
      const withAndWithout = await insertMessages(mixed);
      expect(withAndWithout.error).toBeNull();
      expect((await storedRow(withAndWithout.notebookId))?.messages).toEqual(
        mixed,
      );
      const without = await insertMessages(conversation(4, false));
      expect(without.error).toBeNull();
    });
  });

  describe("one row per notebook", () => {
    test("a second insert for the same notebook conflicts", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      const first = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages: conversation(1) });
      expect(first.error).toBeNull();
      const second = await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages: conversation(3) });
      expect(second.error?.code).toBe(UNIQUE_CONFLICT);
      expect((await storedRow(notebookId))?.messages).toEqual(conversation(1));
    });

    test("an upsert replaces the row", async () => {
      const notebookId = await newNotebook(a.client, a.userId);
      await a.client
        .from(TABLE)
        .insert({ notebook_id: notebookId, messages: conversation(1) });
      const { error } = await a.client
        .from(TABLE)
        .upsert({ notebook_id: notebookId, messages: conversation(3) });
      expect(error).toBeNull();
      const { data: rows } = await admin
        .from(TABLE)
        .select("messages")
        .eq("notebook_id", notebookId);
      expect(rows).toEqual([{ messages: conversation(3) }]);
    });
  });
});
