-- Task D17c. The Refine with AI conversation, one per notebook.
-- Design: cc-reports summary-task-D17a-refine-design.md, section 3.
--
-- A table of its own rather than a column on notebooks: GET /api/notebooks
-- selects * for the whole Explorer list, so a column would send every
-- conversation on every tree load. This table is read only when a dialog
-- opens.
--
-- messages is the conversation as lib/refineConversation.ts checks it:
-- [{ role: "user" | "assistant", content, provider? }, ...]. The shape,
-- the alternation, the per-message lengths and the provider field are the
-- route's job; the database only keeps a backstop (an array, at most 40
-- messages, at most 256 KiB of JSON).
--
-- Not in Realtime (supabase_realtime holds only responses), not in the
-- .pact export, not imported. "Start over" deletes the whole row.
--
-- The grant line: this project's default privileges give anon,
-- authenticated and service_role no SELECT/INSERT/UPDATE/DELETE on a new
-- table (see 20260926120000_user_api_keys.sql). RLS below is what limits
-- access; the grant only lets a query reach it.
--
-- NOT APPLIED TO PREVIEW OR PRODUCTION. For Claude.ai's review, then
-- Nik applies it by hand.

create table public.refine_conversations (
  notebook_id uuid primary key
    references public.notebooks(id) on delete cascade,
  user_id     uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  messages    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint refine_conversations_messages_is_array
    check (jsonb_typeof(messages) = 'array'),
  constraint refine_conversations_message_count
    check (jsonb_array_length(messages) <= 40),
  constraint refine_conversations_size
    check (octet_length(messages::text) <= 262144)
);

create index refine_conversations_user_id_idx
  on public.refine_conversations (user_id);

alter table public.refine_conversations enable row level security;

create policy "Users manage their own refine conversations"
  on public.refine_conversations
  for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.refine_conversations
  to anon, authenticated, service_role;
