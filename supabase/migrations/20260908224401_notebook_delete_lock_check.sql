-- Prevents DELETE /api/notebooks from silently succeeding while one of the
-- notebook's discussions has a genuinely active (non-stale) execution
-- lock — otherwise the in-flight Anthropic call keeps running against a
-- notebook/discussion that no longer exists, and its output is discarded
-- when it eventually resolves. Confirmed as a real risk during review,
-- not yet hit in testing.

-- Single source of truth for the staleness threshold, so
-- try_acquire_execution_lock and the new notebook-delete check below can
-- never drift apart into two different definitions of "stale."
create or replace function public.execution_lock_stale_after()
returns interval
language sql
immutable
as $$
  select interval '5 minutes';
$$;

-- Re-point try_acquire_execution_lock's default at the shared constant
-- above instead of its own literal. Behaviorally identical — same
-- 5-minute value — only the source of truth changes.
create or replace function public.try_acquire_execution_lock(
  p_user_id uuid,
  p_discussion_id uuid,
  p_stale_after interval default public.execution_lock_stale_after()
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_acquired boolean;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id must match the authenticated user';
  end if;

  insert into public.execution_locks (user_id, discussion_id, acquired_at)
  values (p_user_id, p_discussion_id, now())
  on conflict (user_id) do update
    set discussion_id = excluded.discussion_id,
        acquired_at = now()
    where execution_locks.acquired_at < now() - p_stale_after
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

-- Returns the discussion_id of an active (non-stale) execution lock
-- belonging to a notebook, or null if none. execution_locks is keyed by
-- user_id (one lock per user, not per discussion), so this can only ever
-- match the caller's own lock row — SECURITY INVOKER + RLS on both
-- execution_locks ("Users manage their own execution lock") and
-- discussions ("Users manage their own discussions") already restricts
-- this to the caller's own data, the same way every other route in this
-- codebase relies on RLS rather than a separate ownership check.
create or replace function public.notebook_active_execution_lock_discussion_id(
  p_notebook_id uuid
) returns uuid
language sql
security invoker
set search_path = public
as $$
  select el.discussion_id
  from public.execution_locks el
  join public.discussions d on d.id = el.discussion_id
  where d.notebook_id = p_notebook_id
    and el.acquired_at >= now() - public.execution_lock_stale_after()
  limit 1;
$$;
