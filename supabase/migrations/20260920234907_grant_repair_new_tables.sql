-- Repairs a real, live-confirmed gap found while wiring task 22: on
-- production's hosted Supabase project specifically, the `authenticated`
-- role has no table-level privileges on `app_settings`, `execution_timings`,
-- or `user_roles` -- every query against them (even a plain SELECT, using
-- a real authenticated session, not a broken one) returns Postgres error
-- 42501 ("permission denied for table ..."), not "no rows" and not
-- "relation does not exist". The tables and their RLS policies are both
-- present and correct; the base GRANT that RLS depends on to even be
-- evaluated is missing underneath them.
--
-- Confirmed live, not assumed: a session for the production test account
-- (nikolaj.ivancic+cctest@gmail.com) got 42501 on all three tables, while
-- the exact same session read `notebooks` (a long-established table)
-- successfully in the same script run -- ruling out a session/auth
-- problem and narrowing this to these three specific tables.
--
-- Notably, this does NOT reproduce on the instrumented clone
-- (pactresearch-web-instrumented) -- its own `execution_timings` table,
-- created the same way (a raw SQL paste in the Supabase dashboard's SQL
-- Editor, per this task's own context), was read successfully via the
-- anon/authenticated pathway in tasks 15-17 with no grant issue at all.
-- So this isn't a universal "SQL-Editor-created tables need a manual
-- grant" rule -- something specific to production's project differs.
-- The cause wasn't chased further (out of scope for unblocking this
-- task); the fix below is the same either way.
--
-- `user_roles` has been affected since it was created (20260912173629),
-- silently: no route in production has ever called isAdmin() before this
-- task added the first one (app/admin/timings/page.tsx), so this was
-- real but completely dormant until now.
--
-- NOT YET APPLIED: drafted for Nik to review and run himself against
-- production's hosted Supabase project, per the standing rule.
--
-- RLS remains the real access-control layer after this runs -- granting
-- these base table privileges to anon/authenticated/service_role doesn't
-- widen who can see what; every existing policy (owner-only reads,
-- admin-only reads/writes) still applies exactly as written. This only
-- lets the role's own query reach the point where RLS gets evaluated at
-- all, matching the same broad-but-RLS-backed grant already in place
-- (implicitly, via whatever *did* work) for every other table in this
-- schema.

grant select, insert, update, delete on public.app_settings
  to anon, authenticated, service_role;

grant select, insert, update, delete on public.execution_timings
  to anon, authenticated, service_role;

grant select, insert, update, delete on public.user_roles
  to anon, authenticated, service_role;
