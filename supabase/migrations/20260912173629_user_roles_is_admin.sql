-- Admin-role infrastructure. Lays the groundwork for an admin-only
-- response-timing report (built separately, in a cloned repo, per the
-- larger plan already discussed) -- this migration only adds the role
-- flag and its access policy. No admin-only feature or UI ships here.
--
-- No existing table represents user-profile data separate from
-- auth.users -- notebooks/discussions/responses/execution_locks are all
-- content tables keyed by user_id, not profile tables -- so this adds a
-- new small public.user_roles table instead of altering Supabase-managed
-- auth.users directly.
--
-- is_admin is nullable with a default of false (not NOT NULL), per the
-- reviewed design: every row created through the normal insert path gets
-- `false` unless a value is given explicitly, but the column itself
-- allows NULL. The server-side check (lib/isAdmin.ts) treats a NULL
-- value, an explicit false, and a missing row identically -- all "not
-- admin" -- so this looseness carries no behavioral risk.

create table public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  is_admin   boolean default false,
  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

-- Read-only self-check: a user may see their own admin status and
-- nothing else. Deliberately no insert/update/delete policy for regular
-- users -- granting a role is an operator action (direct SQL, run by
-- Nik), not something the app itself should ever let a user do to their
-- own row.
create policy "Users can read their own admin status"
  on public.user_roles
  for select
  using (user_id = auth.uid());
