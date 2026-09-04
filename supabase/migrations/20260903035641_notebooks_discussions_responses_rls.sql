-- Close the per-user ownership gap left open by the Phase B storage layer
-- migration (20260825032825), which explicitly deferred RLS on these three
-- tables. Now that login/callback/middleware are live, any authenticated
-- user could otherwise read or write any other user's notebooks,
-- discussions, and responses.
--
-- This does not address notebooks.is_system or any shared/permissions
-- model — that's the broader access-rights model deferred in 3.13
-- (decision 3) to its own future pass. This migration only closes the
-- per-user ownership gap.
--
-- RLS is enabled and each table's policy is created in the same statement
-- group so there is no window where a table has RLS enabled with no
-- policy yet (which would deny everything, not just unauthorized rows).

alter table public.notebooks enable row level security;
create policy "Users manage their own notebooks"
  on public.notebooks
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.discussions enable row level security;
create policy "Users manage their own discussions"
  on public.discussions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.responses enable row level security;
create policy "Users manage their own responses"
  on public.responses
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
