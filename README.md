# web-with-supa

A Docusaurus + Supabase template. It ships a documentation site with a working
email/password login, password reset, and an account page, all backed by a
local Supabase stack. Use it as the starting point for new projects that need
docs plus auth from day one.

## Stack

- [Docusaurus 3](https://docusaurus.io/) (TypeScript, classic preset) under `/web`
- [Supabase](https://supabase.com/) local dev stack under `/supabase`
- [Playwright](https://playwright.dev/) end-to-end tests under `/web/e2e`, run against the production `docusaurus build`
- GitHub Actions CI: typecheck, e2e against a real local Supabase instance, a Cloudflare Pages preview deploy, and a Lighthouse CI report on each pull request

## Prerequisites

- Node.js 20 or newer
- Docker (Supabase's local stack runs in containers)
- [Supabase CLI](https://supabase.com/docs/guides/cli)

## Quickstart

```bash
# 1. Start the local Supabase stack (Postgres, Auth, Storage, Mailpit)
supabase start

# 2. Install web dependencies and start the dev server
cd web
npm ci
npm start
```

`supabase start` prints the local API URL, anon key, and service role key.
The defaults in `web/docusaurus.config.ts` already match a fresh
`supabase init` stack, so no `.env` file is required for local development.
Set `SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars only if you changed the
local ports or are pointing at a hosted project.

Visit `http://localhost:3001` (the dev server) and use the "Log in" link in
the navbar, or go straight to `/login`.

## Environment variables

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | `web/docusaurus.config.ts` | `http://127.0.0.1:54321` | Supabase API URL baked into the client bundle |
| `SUPABASE_ANON_KEY` | `web/docusaurus.config.ts` | local dev anon key | Public anon key baked into the client bundle |
| `OAUTH_ENABLED` | `web/docusaurus.config.ts` | `false` | Set to `true` once real OAuth provider credentials are configured in `supabase/config.toml` to enable the GitHub/Google buttons on `/login` |
| `SUPABASE_SERVICE_ROLE_KEY` | `web/e2e/global-setup.ts`, `web/e2e/auth-reset.spec.ts` | local dev service role key | Seeds the e2e test user via the Supabase admin API |
| `MAILPIT_URL` | `web/e2e/helpers.ts` | `http://127.0.0.1:54324` | Reads captured password-reset emails during e2e tests |

## Testing

Playwright drives the tests against a production build, not the dev server,
so what passes locally matches what CI checks:

```bash
cd web
npm run test:e2e       # headless
npm run test:e2e:ui    # interactive UI mode
```

Auth specs (`auth-login`, `auth-signup`, `auth-reset`) need Supabase running
locally and skip themselves automatically if `supabase start` hasn't been
run. `smoke.spec.ts` and `account.spec.ts` always run.

TDD workflow: write or update a spec under `web/e2e` first, watch it fail,
then implement the page or component until it passes. See `CLAUDE.md` for
more detail.

## Project structure

```
web/                  Docusaurus site
  docusaurus.config.ts
  src/
    contexts/          AuthContext (Supabase session state)
    lib/                Supabase client
    pages/              login, forgot-password, reset-password, account
    theme/              Root.tsx (wraps app in AuthProvider), custom navbar item
  e2e/                 Playwright specs and helpers
supabase/              Local Supabase config (config.toml, seed.sql)
.github/workflows/     CI: typecheck, e2e, Cloudflare Pages preview, Lighthouse
.claude/skills/writing/  House writing style + a readability checker script
```

## CI

Pull requests run:

1. **Typecheck** (`tsc`)
2. **End-to-end tests** against a real local Supabase instance started in CI
3. **Cloudflare Pages preview deploy** (needs `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` repo secrets. Skipped with a notice if unset.)
4. **Lighthouse CI**, which comments performance/accessibility/best-practices/SEO
   scores on the PR once the preview is deployed

## Writing docs

`.claude/skills/writing/SKILL.md` defines the house voice for docs, READMEs,
and release notes, along with a dependency-free readability checker:

```bash
python3 .claude/skills/writing/scripts/readability.py path/to/doc.mdx
```
