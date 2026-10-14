-- Task 89. Applied to Preview by CC on 2026-10-13 after Claude.ai's review.
-- Production: Nik runs it by hand in the SQL editor; nothing applies it
-- automatically. Rollback: the same rule without the exists (...) part,
-- as in 20260921173354_prompt_images_storage.sql.
--
-- A picture may be uploaded only into a discussion that exists and
-- belongs to the uploader. Before this, the upload rule checked only the
-- first folder ({user_id}), so a prompt box still open on a discussion
-- deleted in another tab stored the picture anyway, as an orphan under
-- the deleted discussion's folder.
--
-- Path convention (unchanged): {user_id}/{discussion_id}/{uuid}.{ext}.
-- The subquery runs as the uploading user, so the discussions table's
-- own row-level security also limits it to their own discussions; the
-- user_id check says the same thing explicitly.
--
-- Reading and deleting pictures are unchanged, so existing pictures,
-- including orphans, can still be read and removed by their owner.
-- Inside the subquery the file's path must be written objects.name:
-- discussions has a name column too, and a bare `name` there means the
-- discussion's name (found by testing: unqualified, every upload was
-- refused).
--
-- No begin/commit here: the migration tool runs each file in one
-- transaction. The copy Nik runs by hand in the SQL editor has them.

drop policy "Users upload their own prompt images" on storage.objects;

create policy "Users upload their own prompt images"
  on storage.objects
  for insert
  with check (
    bucket_id = 'prompt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.discussions d
      where d.id::text = (storage.foldername(objects.name))[2]
        and d.user_id = auth.uid()
    )
  );
