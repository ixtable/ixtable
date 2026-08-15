# CLAUDE.md

This repo is a Docusaurus + Supabase template: a documentation site with a
working login, password reset, and account page, backed by a local Supabase
stack.

## Layout

- `web/`: the Docusaurus site (TypeScript, classic preset)
  - `src/contexts/AuthContext.tsx`: Supabase session state, exposed via `useAuth()`
  - `src/lib/supabaseClient.ts`: lazy, browser-only Supabase client singleton
  - `src/theme/Root.tsx`: wraps the app in `AuthProvider`
  - `src/theme/NavbarItem/ComponentTypes.tsx`: registers the `custom-authNavbarItem` navbar type
  - `src/pages/{login,forgot-password,reset-password,account}.tsx`: auth pages
  - `e2e/`: Playwright specs and helpers
- `supabase/`: local Supabase config (`config.toml`, `seed.sql`)
- `.github/workflows/ci.yml`: typecheck, e2e, Cloudflare Pages preview, Lighthouse CI
- `.claude/skills/writing/`: house writing voice and a readability checker

## Commands

Run from `web/`:

```bash
npm start              # dev server on :3001
npm run build           # production build, used by e2e tests
npm run typecheck       # tsc
npm run test:e2e        # Playwright, headless
npm run test:e2e:ui     # Playwright, interactive
```

From the repo root:

```bash
supabase start          # local Postgres, Auth, Storage, Mailpit
supabase stop
```

## TDD workflow

Playwright tests run against `docusaurus build`, not the dev server, so a
passing spec means the built site actually works.

1. Write or update a spec under `web/e2e` describing the behavior you want.
2. Run `npm run test:e2e` and watch it fail.
3. Implement the page or component.
4. Rerun `npm run test:e2e` until it passes.

`smoke.spec.ts` and `account.spec.ts` need no external services. The auth
specs (`auth-login`, `auth-signup`, `auth-reset`) call the real Supabase
local API and skip themselves automatically when `supabase start` hasn't
been run. Run `supabase start` before working on auth specs so they execute
instead of skipping.

## Auth architecture

`AuthProvider` (in `src/theme/Root.tsx`) wraps the whole site and exposes
`user`, `session`, `loading`, and the auth actions (`signIn`, `signUp`,
`signOut`, `resetPasswordForEmail`, `updatePassword`, `signInWithOAuth`) via
`useAuth()`. The Supabase client is only created in the browser
(`getSupabaseClient` throws if called during server-side rendering), so all
Supabase calls happen inside `useEffect` or event handlers, never at render
time or module scope.

OAuth buttons on `/login` are disabled placeholders until `OAUTH_ENABLED=true`
is set and real provider credentials are added to
`supabase/config.toml` under `[auth.external.*]`.

## Writing docs

Use the `writing` skill (`.claude/skills/writing/SKILL.md`) for any doc,
README, or release notes. It defines the house voice and a banlist of AI
writing tells, enforced by:

```bash
python3 .claude/skills/writing/scripts/readability.py path/to/doc.mdx
```
