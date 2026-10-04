# Incident procedures

## Severity

| Level | Examples | Response |
|---|---|---|
| SEV1 | `health` failing, sign-in down, key grants failing for all apps, suspected secret exposure or cross-tenant data access | page on-call now; incident channel; status page within 15 minutes |
| SEV2 | one function failing, webhook failures (billing state drifting), bundle downloads failing for one region | on-call within 30 minutes; status page if customers notice |
| SEV3 | single customer issue, elevated rate limiting, slow dashboard | next business day via the support queue |

## First response (any severity)

1. Acknowledge the page, open an incident log (time-stamped notes).
2. Check `/functions/v1/health`, the Supabase status page and the Stripe
   status page.
3. Check recent deploys (functions, migrations, website). Roll back the last
   function deploy if the timing matches (`supabase functions deploy` of the
   previous tag).
4. Post a status update; repeat every 30 minutes for SEV1.

## Playbooks

### Key grants failing

Runtime users cannot open apps with cloud credentials.

1. Look at the failure spike query in `monitoring.md`; is it one app or
   all apps?
2. All apps: check the Edge Function logs of `key-grant` for unwrap errors.
   A KEK misconfiguration (missing `IXTABLE_KEK_V<n>` for an envelope's
   `kek_version`) breaks every grant for envelopes of that version: restore
   the secret, do not rewrap in a hurry.
3. One app: use `admin-support {appId}` and follow
   `support-runbook.md` → "Key grant failures".

### Billing webhook failing

1. `select outcome, outcome_reason, error, count(*) from billing_events
   where received_at > now() - interval '1 day' group by 1,2,3;`
2. `signature_failed` rising right after a deploy: the
   `STRIPE_WEBHOOK_SECRET` does not match the Stripe endpoint secret. Fix the
   secret; Stripe retries for 3 days, so no event is lost.
3. `failed` rows: read `error`, fix, then resend the events from the Stripe
   dashboard (Developers → Events → Resend). Processing is idempotent and
   order-safe (`provider_event_at`), so resending everything is safe.
4. Customers whose access flipped wrongly: check `app_entitlement` through
   `admin-support {appId}`. Never edit `subscriptions` by hand; resend the
   latest Stripe event for that subscription instead.

### Suspected secret exposure

1. SEV1. Identify which secret (KEK, signing key, Stripe key, service role
   key, a user's DEK).
2. Signing key: generate a new Ed25519 key, ship a desktop build pinning the
   new public key, keep accepting the old key only until users update.
3. KEK: add `IXTABLE_KEK_V<n+1>`, bump `IXTABLE_KEK_CURRENT_VERSION`, ask
   affected owners to re-upload credentials, then revoke old envelopes.
   Customers must rotate the underlying database passwords (the DEK
   protects the ciphertext, not the database).
4. Service role key: rotate in the Supabase dashboard, redeploy functions.
5. Notify affected customers within the contractual window.

### Abuse or traffic spike

1. `select bucket, count from rate_limits order by count desc limit 20;`
2. One account: ban it in Supabase Auth (Users → ban) and revoke its app
   memberships through `members-update`. Record it in the incident log.
3. Distributed: tighten the Kong/WAF rules at the edge; `RATE_LIMITS`
   changes are a code deploy.

## After the incident

Write a post-incident review within five business days: timeline, impact
(apps, users, duration), root cause, what detected it, and follow-up items
with owners. Add a service-qa spec when the failure was a contract bug.
