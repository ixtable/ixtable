# web

The ixtable website: product docs, pricing, and the ixtable Cloud account and
management dashboard. It is a Docusaurus site that signs users in with Supabase
Auth. It never opens or edits `.ixt` applications.

```bash
npm ci
npm start          # http://localhost:3001
npm run typecheck && npm run build && npm run lint
npm run test:e2e   # Playwright; auth and cloud specs skip without local Supabase
```

Supabase only runs in the browser. Call it from effects and event handlers,
never during render, because Docusaurus renders every page in Node at build
time. Cloud reads and Edge Function calls go through `src/lib/cloud`.

| Variable | Default | Effect |
| --- | --- | --- |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | Supabase API the site talks to |
| `SUPABASE_ANON_KEY` | local demo key | Public anon key |
| `OAUTH_ENABLED` | `false` | Enables Google and Microsoft buttons |
| `OAUTH_GOOGLE_ENABLED` | `false` | Enables only the Google button |
| `OAUTH_MICROSOFT_ENABLED` | `false` | Enables only the Microsoft button |
