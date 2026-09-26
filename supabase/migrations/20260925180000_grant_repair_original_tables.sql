-- Completes the grant repair that 20260920234907_grant_repair_new_tables.sql
-- started, for the four tables that migration did not cover:
-- notebooks, discussions, responses, execution_locks.
--
-- WHY THOSE FOUR WERE MISSED. That migration was written from
-- production's symptoms, and on production these four already worked --
-- its own comment cites reading `notebooks` successfully in the same
-- script run as proof the failure was specific to the three new tables.
-- That was true of production and only production. The four originals
-- have full DML there, applied out-of-band at some point and never
-- recorded in a migration, so nothing in the repo reproduces them.
--
-- WHAT THAT COSTS. A fresh clone plus `supabase db reset` produces a
-- database where notebooks, discussions, responses and execution_locks
-- have no DML for anon/authenticated/service_role, so the E2E suite dies
-- on `42501 permission denied for table notebooks`. Since task 42 the
-- workaround has been to re-apply the grants by hand after every reset;
-- this migration removes the need for that.
--
-- ROOT CAUSE, audited rather than inferred. Default privileges for
-- tables created by `postgres` in schema public (pg_default_acl, read
-- from production):
--
--   anon=Dxtm  authenticated=Dxtm  service_role=Dxtm
--
-- D=TRUNCATE, x=REFERENCES, t=TRIGGER, m=MAINTAIN. No a/r/w/d --
-- no INSERT, SELECT, UPDATE or DELETE. Every table these migrations
-- create is owned by `postgres`, so every one of them starts with
-- exactly those four non-DML privileges and nothing else. The three
-- tables the earlier migration repaired are in the repo precisely
-- because they hit this same default; the four here hit it too, and were
-- invisible only because production had been patched by hand.
--
-- This deliberately grants the tables rather than changing the default
-- privileges for the schema. ALTER DEFAULT PRIVILEGES would silently
-- grant DML on every future table too, which is a policy change nobody
-- asked for; explicit per-table grants keep the decision visible in the
-- same form the existing repair migration already uses.
--
-- SAFE ON PRODUCTION, AND A NO-OP THERE. Verified by audit before
-- writing this: all four tables already hold
-- SELECT/INSERT/UPDATE/DELETE for anon, authenticated and service_role
-- on production. GRANT is idempotent, so applying this re-grants what is
-- already there and changes nothing. Its real effect is on any database
-- built from the repo -- local, CI, or a future clone.
--
-- RLS IS STILL THE ACCESS-CONTROL LAYER. Same reasoning as the earlier
-- migration: these base privileges do not widen who can read or write
-- anything. Every existing policy (owner-scoped reads and writes, the
-- admin-only paths) applies exactly as written. Without the grant the
-- role's query fails before RLS is ever evaluated; with it, RLS decides.
--
-- NOT YET APPLIED TO PRODUCTION: drafted for Nik to review and run
-- himself, per the standing rule. Applied and verified locally only.

grant select, insert, update, delete on public.notebooks
  to anon, authenticated, service_role;

grant select, insert, update, delete on public.discussions
  to anon, authenticated, service_role;

grant select, insert, update, delete on public.responses
  to anon, authenticated, service_role;

grant select, insert, update, delete on public.execution_locks
  to anon, authenticated, service_role;
