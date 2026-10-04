-- ixtable Cloud control plane: core tables.
-- Architecture: docs/decisions/cloud-architecture.md. Security model:
-- docs/decisions/cloud-security-model.md. Row-level security, grants and
-- helper functions live in 20261003000100_cloud_policies.sql.
--
-- Conventions
-- - Every table has RLS enabled (policies migration) and no grants to anon.
-- - Clients (authenticated role) get explicit per-table grants only.
-- - Privileged writes go through Edge Functions using the service role.
-- - Ids are uuid. Desktop-owned ids (role ids, installation ids) keep the
--   desktop uuid so manifests and the Runtime agree on identity.

-- Private by default: tables created by later migrations get no client
-- privileges unless that migration grants them explicitly.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
-- PUBLIC execute on functions is a global default, so it is revoked globally.
-- Every client-callable function needs an explicit GRANT EXECUTE.
alter default privileges for role postgres
  revoke execute on functions from public;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Accounts ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  display_name text not null default '' check (char_length(display_name) <= 200),
  -- Support operators may call admin-support. Set only with the service role.
  is_operator boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_new_user();

-- Tenancy -------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.org_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'billing', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);
create trigger org_members_updated_at before update on public.org_members
  for each row execute function public.set_updated_at();

-- The creator of an organization becomes its owner.
create or replace function public.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.org_members (org_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger on_organization_created after insert on public.organizations
  for each row execute function public.handle_new_organization();

-- An organization always keeps at least one owner (unless it is deleted).
create or replace function public.ensure_org_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
    and exists (select 1 from public.organizations o where o.id = old.org_id)
    and not exists (
      select 1 from public.org_members m
      where m.org_id = old.org_id and m.role = 'owner'
    )
  then
    raise exception 'organization % must keep at least one owner', old.org_id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create trigger org_members_keep_owner after update or delete on public.org_members
  for each row execute function public.ensure_org_has_owner();

-- Cloud applications --------------------------------------------------------

create table public.cloud_apps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  -- Exactly one Developer/Owner per app (PRD §20.1). Transfer is an explicit,
  -- audited operation in an Edge Function.
  owner_id uuid not null references auth.users (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  -- The desktop DocumentConfig id of the application.
  document_id text not null check (char_length(document_id) between 1 and 200),
  datasource_kind text not null default 'sqlite' check (datasource_kind in ('sqlite', 'postgres')),
  backups_enabled boolean not null default false,
  retention_versions integer not null default 20 check (retention_versions between 1 and 1000),
  retention_days integer check (retention_days is null or retention_days between 1 and 3650),
  head_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index cloud_apps_org_idx on public.cloud_apps (org_id);
create index cloud_apps_owner_idx on public.cloud_apps (owner_id);
create unique index cloud_apps_document_live_idx on public.cloud_apps (org_id, document_id)
  where deleted_at is null;
create trigger cloud_apps_updated_at before update on public.cloud_apps
  for each row execute function public.set_updated_at();

-- Custom Runtime User roles. `id` is the desktop role id; `permissions`
-- mirrors the desktop roles.rs shape.
create table public.app_roles (
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, id)
);
create trigger app_roles_updated_at before update on public.app_roles
  for each row execute function public.set_updated_at();

create table public.app_members (
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_id uuid not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (app_id, user_id),
  foreign key (app_id, role_id) references public.app_roles (app_id, id) on delete restrict
);
create index app_members_user_idx on public.app_members (user_id);
create trigger app_members_updated_at before update on public.app_members
  for each row execute function public.set_updated_at();

-- Only the sha256 of the invitation token is stored. The raw token is in the
-- invitation link and nowhere else.
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('org', 'app')),
  org_id uuid references public.organizations (id) on delete cascade,
  app_id uuid references public.cloud_apps (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  org_role text check (org_role in ('admin', 'billing', 'member')),
  role_id uuid,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (
    (kind = 'org' and org_id is not null and org_role is not null and app_id is null)
    or (kind = 'app' and app_id is not null and role_id is not null)
  ),
  foreign key (app_id, role_id) references public.app_roles (app_id, id) on delete cascade
);
create index invitations_email_idx on public.invitations (email);
create index invitations_app_idx on public.invitations (app_id);
create index invitations_org_idx on public.invitations (org_id);

-- Published checkpoints (PRD §22.2). Rows are immutable once written: only
-- the status moves forward (see app_versions_immutable).
create table public.app_versions (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
  -- No foreign key: the history outlives account deletion.
  developer_id uuid not null,
  created_at timestamptz not null default now(),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_size bigint not null check (archive_size > 0 and archive_size <= 524288000),
  storage_path text not null unique,
  migrations jsonb not null default '[]'::jsonb check (jsonb_typeof(migrations) = 'array'),
  min_runtime_version text not null default '0.0.0',
  security jsonb not null default '{}'::jsonb check (jsonb_typeof(security) = 'object'),
  release_notes text not null default '' check (char_length(release_notes) <= 20000),
  status text not null default 'pending' check (status in ('pending', 'published', 'withdrawn')),
  parent_version_id uuid references public.app_versions (id) on delete set null,
  resolution text check (resolution in ('overwrite', 'fork')),
  published_at timestamptz,
  withdrawn_at timestamptz,
  unique (app_id, version)
);
create index app_versions_app_idx on public.app_versions (app_id, created_at desc);

alter table public.cloud_apps
  add constraint cloud_apps_head_version_fk foreign key (head_version_id)
  references public.app_versions (id) on delete set null;

create or replace function public.app_versions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Foreign-key maintenance (parent version deleted by retention) is allowed.
  if new.parent_version_id is null and old.parent_version_id is not null
    and (to_jsonb(new) - 'parent_version_id') = (to_jsonb(old) - 'parent_version_id')
  then
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'published_at', 'withdrawn_at'])
     <> (to_jsonb(old) - array['status', 'published_at', 'withdrawn_at'])
  then
    raise exception 'app_versions rows are immutable'
      using errcode = 'insufficient_privilege';
  end if;
  if not (
    (old.status = 'pending' and new.status in ('published', 'withdrawn'))
    or (old.status = 'published' and new.status = 'withdrawn')
    or old.status = new.status
  ) then
    raise exception 'invalid app_versions status transition % -> %', old.status, new.status
      using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'published' and old.status <> 'published' then
    new.published_at := coalesce(new.published_at, now());
  end if;
  if new.status = 'withdrawn' and old.status <> 'withdrawn' then
    new.withdrawn_at := coalesce(new.withdrawn_at, now());
  end if;
  return new;
end;
$$;
create trigger app_versions_immutable before update on public.app_versions
  for each row execute function public.app_versions_immutable();

-- Signed upload sessions handed out by archive-upload-url.
create table public.archive_uploads (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('version', 'backup')),
  installation_id uuid,
  storage_path text not null unique,
  expected_size bigint not null check (expected_size > 0 and expected_size <= 524288000),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'committed', 'expired', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day',
  committed_at timestamptz,
  check (kind = 'version' or installation_id is not null)
);
create index archive_uploads_app_idx on public.archive_uploads (app_id);

-- Runtime installations (one per device install). `id` is generated by the
-- desktop. Revocation blocks future bundles and key grants.
create table public.installations (
  id uuid primary key,
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_name text not null default '' check (char_length(device_name) <= 200),
  installed_version_id uuid references public.app_versions (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);
create index installations_app_user_idx on public.installations (app_id, user_id);

-- Per-installation backup stream (PRD §23). Never merged across installations.
create table public.installation_backups (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  upload_id uuid references public.archive_uploads (id) on delete set null,
  storage_path text not null unique,
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_size bigint not null check (archive_size > 0 and archive_size <= 524288000),
  created_at timestamptz not null default now()
);
create index installation_backups_inst_idx on public.installation_backups (installation_id, created_at desc);

-- Credentials (PRD §21.3) -----------------------------------------------------

-- Datasource secret encrypted by Studio with a random DEK. The DEK is stored
-- only wrapped with the server KEK (AES-256-GCM, version in kek_version).
create table public.credential_envelopes (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  datasource_id text not null check (char_length(datasource_id) between 1 and 200),
  scope text not null check (scope in ('shared', 'user')),
  user_id uuid references auth.users (id) on delete cascade,
  ciphertext text not null,
  nonce text not null,
  aad text not null default '',
  wrapped_dek text not null,
  kek_version integer not null check (kek_version > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((scope = 'shared') = (user_id is null)),
  unique nulls not distinct (app_id, datasource_id, user_id)
);
create trigger credential_envelopes_updated_at before update on public.credential_envelopes
  for each row execute function public.set_updated_at();

-- One row per issued key grant. The DEK itself is never stored here.
create table public.key_grants (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.cloud_apps (id) on delete cascade,
  envelope_id uuid references public.credential_envelopes (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  datasource_id text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  renewed_from uuid references public.key_grants (id) on delete set null,
  revoked_at timestamptz
);
create index key_grants_app_user_idx on public.key_grants (app_id, user_id, issued_at desc);

-- Billing (PRD §4.2, Phase 5) ------------------------------------------------

create table public.plans (
  id text primary key,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'usd',
  interval text not null default 'month' check (interval in ('month', 'year')),
  runtime_user_allowance integer not null check (runtime_user_allowance >= 0),
  storage_gb integer not null check (storage_gb >= 0),
  stripe_price_id text,
  active boolean not null default true,
  sort integer not null default 0
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null unique references public.cloud_apps (id) on delete cascade,
  plan_id text not null references public.plans (id),
  provider text not null default 'stripe' check (provider in ('stripe', 'fake')),
  status text not null check (status in (
    'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'
  )),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- Webhook idempotency: an event id is processed at most once.
create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  provider text not null default 'stripe',
  type text not null,
  app_id uuid,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- Audit (PRD §25) -------------------------------------------------------------

-- Append-only. No foreign keys so history survives app and account deletion.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_id uuid,
  org_id uuid,
  app_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  ip_hash text
);
create index audit_events_app_idx on public.audit_events (app_id, at desc);
create index audit_events_org_idx on public.audit_events (org_id, at desc);
create index audit_events_actor_idx on public.audit_events (actor_id, at desc);

create or replace function public.audit_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.audit_events_append_only();

-- Operations ----------------------------------------------------------------

create table public.rate_limits (
  bucket text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

create table public.service_metrics (
  name text not null,
  day date not null default current_date,
  count bigint not null default 0,
  primary key (name, day)
);

-- Browser hand-off for desktop OAuth sign-in (PKCE, S256).
create table public.desktop_auth_requests (
  id uuid primary key default gen_random_uuid(),
  state text not null unique check (char_length(state) between 16 and 200),
  code_challenge text not null check (char_length(code_challenge) between 43 and 128),
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  approved_at timestamptz,
  consumed_at timestamptz
);
