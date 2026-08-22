-- Throwaway table used only by the local Vitest integration test to confirm
-- the local Supabase stack (start/reset/teardown) is wired correctly.
-- Not part of the application schema.
create table if not exists public.integration_test_probe (
  id uuid primary key default gen_random_uuid(),
  value text not null,
  created_at timestamptz not null default now()
);

alter table public.integration_test_probe enable row level security;

grant select, insert, update, delete on public.integration_test_probe to service_role;
