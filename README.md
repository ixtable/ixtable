# ixtable

ixtable is a local-first desktop app builder for relational business apps, a modern take on Microsoft Access. The desktop app is free and open source under Apache-2.0. ixtable Cloud is the planned paid service for private app distribution. See `PRD.md` for the product scope.

This repository holds three parts:

- The desktop app: a Tauri shell in `src-tauri/` with a React UI in `src/`.
- The website at [ixtable.com](https://ixtable.com): a Docusaurus 3 site in `web/` with docs, pricing, a blog, and a Cloud waitlist.
- The local Supabase stack in `supabase/`: website auth and the waitlist table, with migrations under `supabase/migrations/`.

## Desktop app

Run these from the repository root:

```bash
npm ci
npm run tauri:dev      # run the desktop app
npm test               # unit and integration tests
```

## Website stack

- [Docusaurus 3](https://docusaurus.io/) with TypeScript and the classic preset, under `/web`
- [Supabase](https://supabase.com/) local dev stack under `/supabase`
- [Playwright](https://playwright.dev/) end-to-end tests under `/web/e2e`, run against the production `docusaurus build`
- GitHub Actions: typecheck and e2e in `ci.yml`, Cloudflare Pages deploy and Lighthouse in `deploy-web.yml`

The deploy workflow sets `GA4_MEASUREMENT_ID` from a repository variable. Only builds with that variable include Google Analytics. Local builds and e2e runs ship no tracking, and the desktop app never loads third-party analytics.

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
| `GA4_MEASUREMENT_ID` | `web/docusaurus.config.ts` | unset | GA4 measurement ID. Unset means no analytics in the build |
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

Specs that call Supabase (`auth-login`, `auth-signup`, `auth-reset`, `waitlist`)
need Supabase running locally and skip themselves automatically if
`supabase start` hasn't been run. The other specs always run.

TDD workflow: write or update a spec under `web/e2e` first, watch it fail,
then implement the page or component until it passes. See `CLAUDE.md` for
more detail.

## Project structure

```
src/, src-tauri/       Desktop app (React UI, Tauri shell)
web/                  Docusaurus site
  docusaurus.config.ts
  blog/                Blog posts
  docs/                Product docs
  src/
    components/        WaitlistForm, auth navbar item
    contexts/          AuthContext (Supabase session state)
    lib/                Supabase client
    pages/              landing, pricing, login, forgot-password, reset-password, account
    theme/              Root.tsx (wraps app in AuthProvider), custom navbar item
  e2e/                 Playwright specs and helpers
supabase/              Local Supabase config, migrations, seed.sql
marketing/seo/         SEO manifest for the external SEO validator
marketing/content/     Publish manifests from the content pipeline
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
