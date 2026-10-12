-- Task 81 Stage 2. An optional, per-user OpenAI API key, stored next to
-- the Anthropic key in public.user_api_keys and encrypted the same way.
--
-- Repo copy (to be added on the Stage 2 branch, same text):
--   supabase/migrations/20261011120000_user_api_keys_openai.sql
--
-- WHAT IS STORED. Never a plaintext key. openai_key_encrypted holds the
-- same "v1:<iv>:<authTag>:<ciphertext>" AES-256-GCM value as
-- anthropic_key_encrypted, encrypted by the server with
-- API_KEY_ENCRYPTION_SECRET, which exists nowhere in this database.
--
-- WHAT DOES NOT CHANGE.
--   * Row-level security: the four owner-only policies on user_api_keys
--     are per row, so they already cover the new column. None is added
--     or changed.
--   * Grants: the existing table-level grant (select, insert, update,
--     delete to anon, authenticated, service_role) already covers a new
--     column. None is added or changed.
--   * Existing rows: the column is nullable with no default, so every
--     existing row simply gets NULL ("no OpenAI key"). No row is
--     rewritten, and the Anthropic key in each row is untouched.
--   * The running app: today's code names only anthropic_key_encrypted
--     and does not read the new column, so this can run before or after
--     the Stage 2 code is deployed.
--
-- Safe to run twice: "if not exists" makes a second run a no-op.

alter table public.user_api_keys
  add column if not exists openai_key_encrypted text;

-- The hand-run copy of this file (task-81-stage-2-openai-key.sql) also
-- recorded version 20261011120000 in supabase_migrations.schema_migrations.
-- That insert is left out here: the Supabase CLI records the version
-- itself when it applies this file, and a second insert of the same
-- version stops "supabase db reset". Same as 20260926120000_user_api_keys.

-- Read-only check, to run afterwards. Expected: one row,
-- openai_key_encrypted | text | YES
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_api_keys'
  and column_name = 'openai_key_encrypted';
