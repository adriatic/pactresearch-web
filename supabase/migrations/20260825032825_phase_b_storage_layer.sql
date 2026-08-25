-- Phase B storage layer migration
-- Implements 3.11 Phase B storage layer design (notebooks / discussions / responses)
-- Source of truth for design rationale: Obsidian note 3.11
-- Scope: single-user Interactive mode only, per 3.10 (Index mode dropped entirely)

create table public.notebooks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  is_system       boolean not null default false,
  system_prompt   text,
  category        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index notebooks_user_id_idx on public.notebooks (user_id);

create table public.discussions (
  id              uuid primary key default gen_random_uuid(),
  notebook_id     uuid not null references public.notebooks(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  parent_id       uuid references public.discussions(id) on delete set null,
  name            text not null,
  total_time_ms   integer not null default 0,
  created_at      timestamptz not null default now()
);

create index discussions_notebook_id_idx on public.discussions (notebook_id);
create index discussions_user_id_idx on public.discussions (user_id);

create table public.responses (
  id              uuid primary key default gen_random_uuid(),
  discussion_id   uuid not null references public.discussions(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  parent_id       uuid references public.responses(id) on delete set null,
  prompt_text     text not null,
  response        text,
  model           text not null default 'claude',
  resolved_model  text,
  cell_type       text not null default 'user',
  image_path      text,
  image_mime_type text,
  created_at      timestamptz not null default now()
);

create index responses_discussion_id_idx on public.responses (discussion_id);
create index responses_user_id_idx on public.responses (user_id);

-- Row-level security: not yet enabled/policies not yet written.
-- Every table above carries user_id specifically to make RLS policies a
-- simple `user_id = auth.uid()` check per table (see 3.11 for rationale) —
-- but enabling RLS and writing the actual policies is separate follow-on
-- work, not assumed done by running this file.
