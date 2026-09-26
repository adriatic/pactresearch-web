-- Task 51. Per-user third-party API credentials, encrypted at the
-- application layer before they ever reach this table.
--
-- WHY A TABLE RATHER THAN user_metadata. Task 50 put profile fields and
-- the model tier in auth user_metadata, deliberately, to avoid a
-- migration for small per-user values. A credential is different on two
-- counts, and both of them matter here:
--
--   1. user_metadata is returned to the browser and travels in the JWT.
--      Even encrypted, a credential should not be handed out on every
--      page load to anything that can read the token.
--   2. user_metadata is CLIENT-WRITABLE via supabase.auth.updateUser().
--      Storage for a credential should only be writable through a server
--      route that controls the encryption, not by arbitrary client code.
--
-- A table with RLS fixes both: the row is owner-scoped, and the column
-- only ever contains ciphertext written by the server.
--
-- WHAT IS STORED. Never a plaintext key. anthropic_key_encrypted holds
-- "v1:<iv>:<authTag>:<ciphertext>", AES-256-GCM, with the key derived
-- from API_KEY_ENCRYPTION_SECRET -- a server-only environment variable
-- that exists nowhere in this database. A dump of this table, on its
-- own, yields nothing usable.
--
-- The owner can read their own ciphertext (the policies below allow it,
-- and the reveal route needs it). That is intentional and safe: it is
-- their own key, it is useless without the server secret, and the only
-- path that turns it back into plaintext is a server route that checks
-- they are the owner first.

create table if not exists public.user_api_keys (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  anthropic_key_encrypted text,
  updated_at             timestamptz not null default now()
);

alter table public.user_api_keys enable row level security;

-- Owner-only, all four verbs. Unlike user_roles (where granting a role
-- is an operator action), managing your own API key IS a user action --
-- it is the entire point of the Keys tab.
drop policy if exists "Users can read their own api keys" on public.user_api_keys;
create policy "Users can read their own api keys"
  on public.user_api_keys
  for select
  using (user_id = auth.uid());

drop policy if exists "Users can insert their own api keys" on public.user_api_keys;
create policy "Users can insert their own api keys"
  on public.user_api_keys
  for insert
  with check (user_id = auth.uid());

drop policy if exists "Users can update their own api keys" on public.user_api_keys;
create policy "Users can update their own api keys"
  on public.user_api_keys
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete their own api keys" on public.user_api_keys;
create policy "Users can delete their own api keys"
  on public.user_api_keys
  for delete
  using (user_id = auth.uid());

-- Explicit grants, deliberately. Task 46 established that this project's
-- default privileges give anon/authenticated/service_role only
-- Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) on a new
-- postgres-owned table in public -- no SELECT/INSERT/UPDATE/DELETE. A
-- new table without these lines works on nobody's machine, and RLS
-- above is what actually restricts access; the grant only lets the
-- query reach the point where RLS is evaluated.
--
-- Written to be safely re-runnable (if not exists / drop policy if
-- exists), because this is pasted into the Supabase SQL editor by hand
-- and running it twice should be a no-op rather than an error.
grant select, insert, update, delete on public.user_api_keys
  to anon, authenticated, service_role;
