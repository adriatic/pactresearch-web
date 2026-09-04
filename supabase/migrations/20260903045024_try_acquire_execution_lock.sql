-- Atomic stale-lock reclamation for execution_locks (3.14 deferred item,
-- "Lock staleness/timeout cleanup for execution_locks").
--
-- A crashed or killed invocation previously left its execution_locks row
-- forever, permanently blocking that user. An application-level
-- "check then delete then insert" sequence would have a race window
-- between two concurrent requests; this closes that gap with a single
-- atomic statement instead.
--
-- INSERT ... ON CONFLICT (user_id) DO UPDATE ... WHERE <stale> is one
-- indivisible operation: Postgres takes a row-level lock on the conflicting
-- execution_locks row before re-evaluating the WHERE clause, so two
-- concurrent callers for the same user serialize on that lock rather than
-- both observing "stale" and both proceeding. If the WHERE clause is false
-- (lock is live), the conflicting row is left untouched and RETURNING
-- yields no row for it — that's the "blocked" signal. If there's no
-- existing row, or the existing row is stale, the row is inserted/updated
-- and RETURNING yields one row — that's the "acquired" signal.
--
-- SECURITY INVOKER (the default — kept explicit here since the task's
-- starting point used SECURITY DEFINER) rather than SECURITY DEFINER:
-- execution_locks' primary key is user_id, so ON CONFLICT (user_id) can
-- only ever match the caller's *own* row — there's no scenario where this
-- function needs to touch another user's lock, so DEFINER would add a
-- privilege-escalation surface (bypassing the "Users manage their own
-- execution lock" RLS policy) for no actual benefit. The explicit
-- p_user_id = auth.uid() guard below is defense-in-depth on top of that:
-- it gives a clear error instead of relying solely on RLS's WITH CHECK
-- failure if this is ever called incorrectly.
create or replace function public.try_acquire_execution_lock(
  p_user_id uuid,
  p_discussion_id uuid,
  p_stale_after interval default interval '5 minutes'
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
