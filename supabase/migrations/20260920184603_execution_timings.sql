-- Durable, admin-gated timing data for /api/execute. The console.log-only
-- [timing]/[timing-full]/[timing-detail] lines this port's own change
-- removed are replaced by real OpenTelemetry spans/attributes for live
-- tracing -- but Vercel's own trace retention on the Hobby plan tops out
-- at 1 hour (Always-on Tracing), nowhere near durable enough for an
-- admin-gated timing report. This is that table.
--
-- Ported from the instrumented clone (pactresearch-web-instrumented),
-- where this exact schema was already built, reviewed, and proven with
-- real rows -- see that repo's 20260919230258_execution_timings.sql.
-- NOT YET APPLIED: drafted for Nik to review and run himself against
-- production's hosted Supabase project, per the standing rule -- do not
-- run this migration as part of applying it.
--
-- NOT YET WRITTEN TO: this migration only creates the table and its
-- policies. The actual INSERT in app/api/execute/route.ts, and the
-- admin-gated report page reading it, are both deliberate, separate
-- follow-up work, added only once this migration has been applied and
-- confirmed.
--
-- One row per completed /api/execute invocation, written by the same
-- authenticated user whose request it was -- the same session-scoped
-- client already used for that route's responses/discussions writes, not
-- a service-role write -- so the ordinary "Users manage their own" RLS
-- insert policy applies. Reads are broadened to admins in addition to
-- the owning user: the entire point of this table is a report an admin
-- can read across every user's runs, not just their own -- reusing
-- user_roles/is_admin, already live on production
-- (20260912173629_user_roles_is_admin.sql).
--
-- discussion_id is ON DELETE SET NULL, unlike every other content table
-- in this schema (which CASCADE) -- deleting a discussion should not
-- silently erase its own timing history out of what's meant to be a
-- durable report.
--
-- settings_read_ms will read NULL on every row until production also
-- gets the app_settings-backed max_tokens read (20260920184602 plus its
-- own follow-up wiring task) -- production's /api/execute doesn't have
-- a settings-read phase yet. The schema is ported as-is from the clone
-- regardless, since the column is genuinely just unused until then, not
-- wrong.

create table public.execution_timings (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  discussion_id             uuid references public.discussions(id) on delete set null,
  resolved_model            text,
  max_tokens                integer,
  auth_ms                   integer,
  lock_acquire_ms           integer,
  settings_read_ms          integer,
  anthropic_connect_ms      integer,
  message_start_insert_ms   integer,
  time_to_first_token_ms    integer,
  generation_ms             integer,
  throttled_write_count     integer,
  throttled_write_total_ms  integer,
  final_write_ms            integer,
  lock_release_ms           integer,
  total_ms                  integer,
  created_at                timestamptz not null default now()
);

create index execution_timings_user_id_idx on public.execution_timings (user_id);
create index execution_timings_discussion_id_idx on public.execution_timings (discussion_id);
create index execution_timings_created_at_idx on public.execution_timings (created_at);

alter table public.execution_timings enable row level security;

-- Written by /api/execute on behalf of the caller -- same shape as the
-- "Users manage their own X" policies on notebooks/discussions/responses,
-- narrowed to insert+select only. No update/delete policy for regular
-- users: this is append-only diagnostic data, same reasoning as
-- user_roles having no self-service write policy at all.
create policy "Users can insert their own execution timings"
  on public.execution_timings
  for insert
  with check (user_id = auth.uid());

create policy "Users can read their own execution timings"
  on public.execution_timings
  for select
  using (user_id = auth.uid());

-- Postgres RLS OR's multiple permissive policies for the same command
-- together, so this and the owner-read policy above compose correctly:
-- an admin matches this one, everyone else falls through to the
-- owner-only policy.
create policy "Admins can read all execution timings"
  on public.execution_timings
  for select
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and is_admin = true
    )
  );
