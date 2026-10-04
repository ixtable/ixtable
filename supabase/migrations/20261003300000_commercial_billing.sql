-- ixtable Cloud commercial functions (PRD §4.2, §25, Phase 5): billing
-- checkout sessions, out-of-order webhook protection, and support lookups.
-- Owned by the billing-*, stripe-webhook, account-* and admin-support
-- functions. Default privileges are revoked (20261003000000_cloud_core.sql),
-- so every grant here is explicit.

-- Checkout sessions handed out by billing-checkout. The fake provider's
-- website page completes a pending session through billing-fake-complete,
-- which posts a signed Stripe-shaped event to stripe-webhook. Function-only:
-- no client grants, no policies.
create table public.billing_checkout_sessions (
  id text primary key check (char_length(id) between 8 and 255),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  plan_id text not null references public.plans (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('stripe', 'fake')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day',
  completed_at timestamptz
);
create index billing_checkout_sessions_app_idx on public.billing_checkout_sessions (app_id, created_at desc);
alter table public.billing_checkout_sessions enable row level security;
revoke all on public.billing_checkout_sessions from anon, authenticated;
grant all on public.billing_checkout_sessions to service_role;

-- Creation time (Stripe `event.created`) of the newest provider event applied
-- to the row. stripe-webhook skips older events so a late retry cannot
-- regress the subscription (e.g. a stale `active` after `canceled`).
alter table public.subscriptions add column provider_event_at timestamptz;

-- Webhook processing outcome for operations (monitoring/support):
-- applied | ignored | stale | failed.
alter table public.billing_events add column outcome text
  check (outcome is null or outcome in ('applied', 'ignored', 'stale', 'failed'));
-- Why an event was ignored or stale (e.g. other_subscription), for support.
alter table public.billing_events add column outcome_reason text;
create index billing_events_app_idx on public.billing_events (app_id, received_at desc);
create index billing_events_unprocessed_idx on public.billing_events (received_at)
  where processed_at is null;

-- Support lookups by email (admin-support).
create index if not exists profiles_email_lower_idx on public.profiles (lower(email));
