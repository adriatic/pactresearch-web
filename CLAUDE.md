@AGENTS.md

## Working rules

These rules hold in every session: on Nik's Mac ("Mac mode") and in a cloud
session. A cloud session does not see the Mac's memory notes, so this file is
where the rules live.

### Keys and databases

- Never use or ask for the Supabase service-role key, not even for a Preview.
  Never put it in an environment variable, a script or a report.
- Never touch Production's database. Nik runs migrations by hand after
  Claude.ai has reviewed them. Approved SQL may be applied to Preview only.
- The Supabase CLI link in this repository points at Production. Reach
  Preview only by naming its project explicitly. Never relink.
- The OpenAI and Anthropic keys are never pasted into chat, messages or
  reports. They live only under Account, Keys in pact-web.
- Never open key or environment files (such as `.env.local`); refer to them
  by name only. Never print or ask for any key, password or token.

### Reports

- Write a report for every task: `summary-task-NNN-name.md` (steps for Nik)
  and, where useful, `status-report-task-NNN-name.md`.
- Reports go into the cc-reports repository, folder `reports/`, committed and
  pushed to `main`. In Mac mode they also go into the Mac folder
  `CC reports and tasks`, with the same name and content.
- The conventions are in cc-reports' `CLAUDE.md`.
- The report, not the chat, is the record. Update it in the same turn
  whenever the task moves forward. Never leave a placeholder.
- Keep the chat reply short and point to the report.
- If this file and cc-reports' CLAUDE.md disagree, cc-reports wins on report
  conventions and this file wins on everything else.

### Writing about people

- Nik is referred to as "Nik", or they/them. Do not infer pronouns from the
  name.

### How to work

- Verify, do not assert. Prove a claim by running the check and reporting
  the result; say plainly what is verified and what is a best guess.
- If you see a weak spot in your own fix, say so and test it.
- A new test must fail on the old code and pass on the new.
- If a test run looks worse than an earlier one, report it. Do not re-run
  until the number looks good.
- Nik's own hands-on check is the gate. Never call a fix done before it.
- Preview only until Nik asks for a merge. Merge only after Nik confirms.
- Paste complete SQL, or any command Nik must run, inline in the chat and in
  the report, every time, even if it is the same as before.
- When recommending that something be removed, name beside it what must NOT
  be removed, especially things with similar names.
- After a CSS change, check the stylesheet Vercel actually deployed, not just
  the code. The build cache has shipped stale CSS before.

### Cloud sessions

- Production live checks (signed in) stay in Mac mode. Their test session
  is made with a key that never leaves the Mac.
- The Task 90 helper (moving `.pact` exports into the PACT inbox) is
  Mac-only.
- Branch deletion is refused by the proxy, so Nik deletes old branches on
  GitHub's website.
- In a cloud session, install packages with npm ci, never with npm install.
  Never change package-lock.json; if it has changed, restore it with git
  checkout before you commit.
