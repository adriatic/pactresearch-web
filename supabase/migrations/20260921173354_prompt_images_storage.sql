-- New private Supabase Storage bucket for prompt-side pasted/dropped
-- images (the rich-composer design proposal, task 28) -- nothing existed
-- for this before: no bucket, no storage.objects policy, anywhere in
-- this project until now (confirmed by grep across every migration and
-- every app/lib/utils file).
--
-- Private, not public: access is gated the same way every table in this
-- app already is (owner-only), not open to anyone with a guessed URL.
--
-- Path convention every policy below assumes: {user_id}/{discussion_id}/
-- {random-uuid}.{ext} -- user_id first is what makes the single
-- storage.foldername(name))[1] = auth.uid()::text predicate work for
-- all three policies; discussion_id second is what lets cleanup-on-delete
-- (DELETE /api/discussions, DELETE /api/notebooks) remove every image
-- for a discussion with one prefix-scoped list() call, no need to parse
-- image references back out of draft_content/prompt_content to find them.
--
-- Size/type limits: see the design doc's own caveat -- reasoned from
-- Anthropic's current published image guidance, worth a fresh check
-- against their docs at build time rather than trusted as permanent.
--
-- Already reviewed and applied to production by Nik directly from task
-- 28's design proposal report before this task (28's implementation)
-- began -- verified live against production (bucket exists, all three
-- policies enforce correctly, including cross-user isolation) before any
-- code in this task was written. This file records that change in the
-- repo's own migration history (and lets `supabase db reset` apply it
-- locally for tests) but does not itself need to be re-run against the
-- hosted project.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'prompt-images',
  'prompt-images',
  false,
  5242880, -- 5MB
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp']
);

create policy "Users upload their own prompt images"
  on storage.objects
  for insert
  with check (
    bucket_id = 'prompt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users read their own prompt images"
  on storage.objects
  for select
  using (
    bucket_id = 'prompt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete their own prompt images"
  on storage.objects
  for delete
  using (
    bucket_id = 'prompt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
