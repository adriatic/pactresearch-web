-- Persists the composer's in-progress draft per discussion, so switching
-- away and back re-fetches it exactly like history/result/everything else
-- already loaded from the database — no special-cased in-memory value,
-- nothing to reset on discussionId change. Supersedes the approach shipped
-- in 4d64d02 (task #2 of pact-web-03), which cleared promptText on every
-- switch instead of persisting it.
--
-- Plain text, matching the composer's actual content shape today
-- (ExecuteTester's promptText is a plain string bound to a <textarea>) —
-- not a structured/JSON column, since there's nothing structured to store
-- yet. Additive only, nullable, no default beyond null (no draft).
alter table public.discussions
  add column draft_prompt_text text;
