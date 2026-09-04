-- Execution-slot persistence for Phase C core execution
-- Implements the execution_locks table decided in 3.12 (Obsidian note 3.12,
-- "Execution-slot persistence — execution_locks table")
-- Additive only: does not modify notebooks/discussions/responses (20260825032825).

create table public.execution_locks (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  discussion_id uuid not null references public.discussions(id) on delete cascade,
  acquired_at   timestamptz not null default now()
);

alter table public.execution_locks enable row level security;

create policy "Users manage their own execution lock"
  on public.execution_locks
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
