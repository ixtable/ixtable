# Production configuration checklist

The local stack (`supabase/config.toml`, `scripts/cloud/dev-secrets.mjs`)
is tuned for tests: email confirmations off, fake billing, throwaway keys.
A hosted production project must differ in every row below. Check them
before the first deploy and after any project or secret change.

## Auth

| Setting | Production value | Why |
|---|---|---|
| Email confirmations (`[auth.email] enable_confirmations`) | **on** | Invitations bind to the invitee's email. Without confirmation anyone can sign up as `victim@company.com` and accept their invitation. `invitations-accept` refuses (500, `details.reason: "email_confirmations_disabled"`) while `IXTABLE_ENV=production` and Auth reports `mailer_autoconfirm`. |
| Site URL and redirect URLs | the website origin only | OAuth, recovery and invitation links land there. |
| Google and Microsoft providers | real client ids and secrets in the project settings | never the local placeholders |
| Password policy and rate limits | Supabase defaults or stricter | |

## Edge Function secrets

Set with `supabase secrets set --env-file <file>` from the secret manager.
`supabase/functions/.env.example` lists every variable.

| Variable | Production value |
|---|---|
| `IXTABLE_ENV` | `production` (turns on the production guards) |
| `IXTABLE_PUBLIC_API_URL` | (Supabase rejects secret names starting with `SUPABASE_`.) The public API origin, e.g. `https://<ref>.supabase.co`. Signed storage URLs are rebased onto it; request headers are never trusted for this. Unset on a hosted project means "keep the URL Storage minted"; an internal URL then fails the request. |
| `BILLING_PROVIDER` | `stripe` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | live keys; webhook endpoint `…/functions/v1/stripe-webhook` |
| `IXTABLE_ALLOW_FAKE_BILLING` | **unset**. With it unset the fake provider and `billing-fake-complete` refuse to run, even if `BILLING_PROVIDER=fake` is left over. |
| `IXTABLE_CLOUD_SIGNING_KEY` | production Ed25519 key (PKCS8 base64); its public key is pinned into desktop release builds (`IXTABLE_CLOUD_PUBLIC_KEY_RAW` at build time) |
| `IXTABLE_KEK_V1` … `IXTABLE_KEK_CURRENT_VERSION` | 32 random bytes each, from the secret manager |
| `IXTABLE_FINGERPRINT_SECRET` | 32 random bytes. Required: `desktop-auth-exchange` fails closed (500) without it. |
| `SITE_URL`, `CORS_ALLOWED_ORIGINS` | the website origin |

## Rotation

| Secret | How | Effect |
|---|---|---|
| KEK | add `IXTABLE_KEK_V<n+1>`, bump `IXTABLE_KEK_CURRENT_VERSION`; keep old versions until every envelope is re-wrapped | new envelopes use the new key; old ones still unwrap |
| Bundle signing key | ship a desktop release that pins the new public key first, then switch the secret | older desktops refuse new bundles (fail closed) until updated |
| Fingerprint secret | replace | earlier bundle fingerprints and audit IP hashes no longer correlate with new ones; rate-limit buckets reset |
| Stripe keys | roll in the Stripe dashboard, update the secrets | |
| Service role / JWT secret | rotate in the Supabase dashboard | signs out every session |

Record every rotation in the incident log (date, secret, operator).

## Before go-live

- [ ] `curl https://<ref>.supabase.co/auth/v1/settings -H "apikey: <anon>"` shows `"mailer_autoconfirm": false`.
- [ ] `GET /functions/v1/health` answers `{ok:true}` with the release version.
- [ ] `billing-fake-complete` answers 404.
- [ ] A test invitation's accept link and a signed archive URL use the public origins.
- [ ] The desktop release was built with the production cloud URL, anon key and public key.
