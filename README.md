# pactresearch-next

> **Status:** Private repository.

The customer-facing web application for [Pact Research LLC](https://pactresearch.net), deployed at `app.pactresearch.net`. Handles customer intake, authentication, payment capture, and research request delivery.

Customers submit research requests through an IPR (Iterative Prompt Refinement) chat interface. Nik runs PACT locally on his Mac to produce the research, then delivers a signed PDF. Payment is captured manually after delivery.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Setup](#setup)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Key Design Decisions](#key-design-decisions)

---

## Architecture

```
pactresearch-next/
├── app/
│   ├── api/
│   │   ├── proxy.ts        # PKCE magic-link cookie handler (Supabase auth)
│   │   └── ...
│   ├── dashboard/          # Authenticated customer area
│   ├── request/            # IPR chat interface for submitting research requests
│   └── ...
├── components/
├── lib/
│   ├── supabase/           # Supabase client + server helpers
│   └── stripe.ts           # Stripe SetupIntent helpers
├── public/
├── .nvmrc                  # Node 20 LTS
├── next.config.js          # Webpack (not Turbopack)
└── package.json
```

**Runtime:** Next.js 16, Node 20 LTS (pinned via `.nvmrc`), Webpack build.

**Auth flow:** Supabase magic-link with PKCE. The PKCE verifier is stored in a cookie (not `localStorage`) via `proxy.ts` to support cross-browser magic-link clicks.

**Database:** Supabase (Postgres). Key tables:

| Table | Notable columns |
|-------|----------------|
| `profiles` | `is_beta` (boolean) — bypasses Stripe for beta testers |
| `requests` | `parent_request_id` (nullable) — reserved for future "continue research" feature |

---

## Features

- **IPR chat interface** — replaces plain request form; multi-turn Claude Haiku conversation refines the research question before submission
- **Supabase Auth** — magic-link login, PKCE-safe cross-browser flow
- **Stripe SetupIntent** — payment method captured upfront; charge triggered manually after PDF delivery
- **Beta bypass** — `is_beta = true` in `profiles` skips Stripe entirely for beta testers (Marc, Beau, Barry)
- **Resend** — transactional email for magic links and delivery notifications
- **Research request tracking** — customers can view request status in their dashboard

---

## Setup

### Prerequisites

- Node.js 20 LTS (`nvm use` will pick up `.nvmrc`)
- A Supabase project (auth + database)
- A Stripe account (SetupIntent mode)
- A Resend account (transactional email)

### Install and run

```bash
cd pactresearch-next
nvm use
npm install
npm run dev -- --webpack    # Turbopack causes memory leaks with Node 20 — always use --webpack
```

### Sensitive file editing

Edit `.env.local` in **BBEdit**, not VSCode — VSCode's text selection can silently drop characters when editing API keys.

---

## Environment Variables

All secrets live in `.env.local` (not committed).

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `RESEND_API_KEY` | Resend API key for transactional email |
| `NEXTAUTH_URL` | `https://app.pactresearch.net` in production |

---

## Deployment

**Host:** Vultr VPS at `45.77.191.105`  
**Process manager:** pm2  
**Reverse proxy:** Nginx  
**CI/CD:** GitHub Actions (push to `main` triggers deploy)  
**SSL:** certbot

### SSH access

```bash
ssh pact    # alias in ~/.ssh/config, key at ~/Work/.ssh/id_pact
```

### Manual deploy (if CI/CD is bypassed)

```bash
ssh pact
cd ~/pactresearch-next
nvm use
npm install
npm run build
pm2 restart pactresearch-next
```

### Force CI/CD without a code change

```bash
git commit --allow-empty -m "trigger deploy"
git push
```

### Nginx notes

- Remove the `default` site from `/etc/nginx/sites-enabled/` — it takes priority and blocks custom configs
- UFW blocks port 80 by default on fresh Ubuntu — run `sudo ufw allow 'Nginx Full'`

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Node 20 LTS (not 24) | Turbopack + Node 24 causes dev server memory leak |
| `--webpack` flag | Turbopack incompatible with this stack; always build with Webpack |
| PKCE verifier in cookies | `localStorage` is not shared across browsers; magic-link clicks can open in a different browser |
| `proxy.ts` for auth | Handles the PKCE exchange server-side to keep the cookie flow intact |
| `is_beta` flag in `profiles` | Lets beta testers use the service without going through Stripe |
| `parent_request_id` nullable | Schema is ready for the "continue research" feature; not yet wired up in UI |
| Manual payment trigger | Payment captured after PDF delivery — not at request submission |



# pactresearch-next

Next.js 16 + Supabase Auth frontend for [pactresearch.net](https://pactresearch.net) — the PACT Research Service.

## Stack

- Next.js 16.2.6 (App Router, Turbopack)
- Supabase Auth (magic-link, SSR)
- @supabase/ssr
- TypeScript

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment

Create `.env.local` at the root:
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

Use the **legacy anon key** (starts with `eyJ`) from Supabase → Settings → API Keys → Legacy tab. The new publishable keys (`sb_publishable_xxx`) work differently and are not yet required.

## Auth Architecture

Magic-link authentication via Supabase. Flow:

1. User enters email at `/login`
2. Supabase sends a magic link
3. User clicks link → hits `/auth/callback` → session established via cookie
4. Redirected to `/dashboard`

Sessions persist via cookie. Return visits go straight to `/dashboard`.

## Hard-won lessons (Next.js 16 + Supabase)

These cost real debugging time. Document them here so they don't cost it again.

### 1. middleware.ts is deprecated in Next.js 16
Next.js 16 renamed `middleware.ts` to `proxy.ts`. The exported function changes from `middleware` to `proxy`. Most Supabase documentation and tutorials still show the old pattern and will produce a deprecation warning. Use `proxy.ts`.

### 2. PKCE magic links break across browsers
Supabase magic links use PKCE by default. The PKCE code verifier is stored in the browser that initiated the login. If the email link opens in a different browser (which the user cannot control), auth fails with:
AuthPKCECodeVerifierMissingError: PKCE code verifier not found in storage
**Fix:** the `proxy.ts` file stores the PKCE verifier in a cookie instead of localStorage, making it available regardless of which browser opens the link. Without `proxy.ts`, magic links are unreliable in production.

### 3. Supabase email rate limit on free tier
Free tier allows 3 emails per hour. During development this limit is easy to hit. Wait 1 hour and try again. There is no workaround.

### 4. Supabase API key transition
Supabase is migrating from legacy keys (`eyJ...` anon key) to new publishable keys (`sb_publishable_xxx`). Legacy keys work until end of 2026. Use legacy keys for now — the new key format requires additional setup not yet documented clearly.

### 5. Documentation lag
The Next.js + Supabase + @supabase/ssr stack is a moving target. Three projects evolving independently, docs written at different times. Any tutorial older than a few months may reference deprecated patterns. Always check package versions before following a guide.

## Project structure
app/
login/page.tsx        # Magic-link login form
dashboard/page.tsx    # Protected page, shows authenticated user
auth/callback/route.ts # Handles Supabase auth redirect
utils/
supabase/
client.ts           # Browser client
server.ts           # Server client (SSR)
proxy.ts                # Session cookie management (replaces middleware.ts)
.env.local              # Not committed — see Environment section above

## Deployment

Target: Vultr Ubuntu 24.04 (45.77.191.105), Nginx, SSL via certbot.
CI/CD: GitHub Actions on push to `main`.