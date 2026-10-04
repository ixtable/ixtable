# Monitoring and alerting

PRD §27.5: cloud health, authentication, publishing, storage and
key-service metrics are monitored.

## Signals

| Signal | Source | How to read it |
|---|---|---|
| Liveness | `GET /functions/v1/health` (no auth) | `{ok, db, storage, version}`; 503 when the database or the archive bucket is unreachable |
| Service counters | `public.service_metrics(name, day, count)` | daily counters written by functions through `incrementMetric` |
| Audit trail | `public.audit_events` | append-only; one row per access-relevant action |
| Webhook outcomes | `public.billing_events(outcome, outcome_reason, error)` | applied, ignored, stale, failed per Stripe event |
| Platform | Supabase dashboard (API, Auth, Storage, Edge Function logs and invocations) and Stripe dashboard (webhook delivery) | latency, 5xx, function errors, delivery retries |

Metric names in use (prefix match is fine for dashboards):

- Billing: `billing.checkout`, `billing.cancel`, `billing.webhook.received`,
  `billing.webhook.applied|ignored|stale|duplicate|failed|signature_failed|malformed`,
  `billing.replace_cancel_failed`.
- Account: `account.export`, `account.delete`.
- Distribution and keys (C1a/C1b functions): `bundles.generate`, `key.issue`,
  `key.renew`, `credential.upload`, `auth.desktop_exchange`, and their
  failure counters where the functions record them.

## Probes

- Uptime check every minute on `/functions/v1/health` from two regions.
  Page when two consecutive checks fail or `ok` is false.
- Synthetic sign-in every 15 minutes with a dedicated monitoring account
  (email/password) followed by a PostgREST `select` on `plans`. Page on two
  consecutive failures.

## Alert rules

Run these every 5 minutes with a read-only database role (or a scheduled
Supabase SQL job that posts to the alert webhook). Thresholds are starting
points; tune them after a month of baseline data.

```sql
-- Key grant failure spike: failures in the last hour vs grants.
select a.action, count(*)
from public.audit_events a
where a.at > now() - interval '1 hour'
  and (a.action like 'key.%' or a.action like 'bundle.%')
  and (a.action ~ '(fail|denied|refused|error)' or a.details ? 'error')
group by 1;
-- Alert: > 20 per hour, or > 10% of key.issue + key.renew in the same hour.

-- Webhook failures and backlog.
select count(*) filter (where outcome = 'failed') as failed,
       count(*) filter (where processed_at is null and received_at < now() - interval '15 minutes') as stuck
from public.billing_events
where received_at > now() - interval '1 hour';
-- Alert: failed > 0 for two runs in a row, or stuck > 0.

-- Signature failures (attack or rotated secret).
select count from public.service_metrics
where name = 'billing.webhook.signature_failed' and day = current_date;
-- Alert: increase of > 50 since the previous run.

-- Subscriptions out of step with Stripe: active rows whose period ended.
select app_id, status, current_period_end from public.subscriptions
where status in ('active', 'trialing') and current_period_end < now() - interval '2 days';
-- Alert: any row (a renewal webhook was missed; replay it from Stripe).
```

Also alert on: Stripe "webhook endpoint failing" email (configure the ops
alias), Edge Function error rate > 2% over 10 minutes (Supabase logs),
database CPU > 80% for 15 minutes, storage 5xx > 1%.

## Rate limits

Per-endpoint limits are one table, `RATE_LIMITS` in
`supabase/functions/_shared/rateLimit.ts` (bucket `<function>:<subject>`,
fixed window, stored in `public.rate_limits`). A blocked call returns 429
`RATE_LIMITED` with `details.retryAfterSeconds`. To see who is being
limited:

```sql
select bucket, count, window_start from public.rate_limits
where window_start > now() - interval '1 hour' order by count desc limit 50;
```

Raising a limit is a code change to `RATE_LIMITS` (reviewed and deployed),
not a database edit. To unblock one user during an incident, delete their
bucket row (`delete from public.rate_limits where bucket = '<bucket>'`) and
record it in the incident log.

## Retention

`service_metrics` and `rate_limits` hold no personal data. Audit events are
kept for the life of the service (append-only; account deletion keeps the
rows with the user id as actor). `billing_events` stores a minimal event
summary (ids, status, metadata), not Stripe customer details.
