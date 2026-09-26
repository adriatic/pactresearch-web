# pactresearch-web

> **Status:** Private repository.

Early scaffolding. The Vercel deployment is live and currently shows only a placeholder page — no functional app yet.

---

## Setup

### Prerequisites

- Node.js 20 LTS (`nvm use` will pick up `.nvmrc`)
- Docker, for local Supabase. **If you use colima, give the VM at least 4 CPUs and 6 GiB
  of memory** — colima's defaults are 2 CPU / 2 GiB, which is not enough to run the
  Supabase stack and the E2E suite at the same time:

  ```bash
  colima start --cpu 6 --memory 8   # once; colima remembers the setting
  ```

  On the defaults the eleven Supabase containers occupy ~1.5 GiB of a 1.9 GiB VM at
  idle, and a full `npm run test:e2e` run drives `MemAvailable` down to single-digit
  megabytes. The kernel then OOM-kills whichever container is largest (in practice
  `supabase_analytics`), and because the OOM is global every other service degrades
  with it — the auth service starts returning `AuthRetryableFetchError` mid-suite and
  specs fail on timeouts that have nothing to do with the code under test. The symptom
  is a suite whose pass/fail count changes run to run on identical code.

  Measured on this repo: 19 failed / 34 passed in 2.0 min at 2 GiB, versus 4 failed /
  49 passed in ~58 s at 8 GiB, with the same four failures every run. See
  `status-report-task-47-e2e-suite-stability.md`.

### Install and run

```bash
cd pactresearch-web
nvm use
npm install
npm run dev -- --webpack    # Turbopack causes memory leaks with Node 20 — always use --webpack
```
