# pactresearch-web

> **Status:** Private repository.

Early scaffolding. The Vercel deployment is live and currently shows only a placeholder page — no functional app yet.

---

## Setup

### Prerequisites

- Node.js 20 LTS (`nvm use` will pick up `.nvmrc`)

### Install and run

```bash
cd pactresearch-web
nvm use
npm install
npm run dev -- --webpack    # Turbopack causes memory leaks with Node 20 — always use --webpack
```
