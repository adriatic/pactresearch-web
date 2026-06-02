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