-- ixtable Cloud: archive bucket, storage lockdown and plan catalog.

-- Private archive bucket (also declared in supabase/config.toml for local
-- stacks). 500 MiB per archive (PRD §7.4, §23).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app-archives', 'app-archives', false, 524288000,
  array['application/octet-stream', 'application/zip', 'application/x-ixtable']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Clients never touch archive objects directly. Edge Functions mint signed
-- download and upload URLs with the service role. This restrictive policy
-- keeps that true even if a later migration adds a permissive storage policy.
create policy app_archives_no_client_access on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'app-archives')
  with check (bucket_id <> 'app-archives');

-- Plan catalog (PRD §4.2). Prices are placeholders until launch pricing is
-- set. stripe_price_id is set per environment by operations (seed.sql sets
-- fake ids for local stacks).
insert into public.plans (id, name, price_cents, currency, interval, runtime_user_allowance, storage_gb, sort)
values
  ('starter', 'Starter', 1900, 'usd', 'month', 5, 5, 1),
  ('team', 'Team', 4900, 'usd', 'month', 25, 25, 2),
  ('business', 'Business', 14900, 'usd', 'month', 100, 100, 3)
on conflict (id) do nothing;
