-- ixtable Cloud: helper functions, row-level security and client grants.
-- Private by default: anon gets nothing; authenticated gets only what is
-- granted here, filtered by RLS. Edge Functions use the service role.

-- Helpers -------------------------------------------------------------------
-- Security definer so policies can consult membership tables without
-- recursive RLS evaluation. All take ids and read auth.uid().

create or replace function public.is_org_member(p_org_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

create or replace function public.is_app_owner(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cloud_apps a
    where a.id = p_app_id
      and a.owner_id = (select auth.uid())
      and a.deleted_at is null
  );
$$;

-- Owner of the app, or owner/admin of the app's organization.
create or replace function public.is_app_admin(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cloud_apps a
    where a.id = p_app_id
      and a.deleted_at is null
      and (
        a.owner_id = (select auth.uid())
        or exists (
          select 1 from public.org_members m
          where m.org_id = a.org_id
            and m.user_id = (select auth.uid())
            and m.role in ('owner', 'admin')
        )
      )
  );
$$;

-- Active Runtime User of a live app.
create or replace function public.is_app_member(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    join public.cloud_apps a on a.id = m.app_id
    where m.app_id = p_app_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and a.deleted_at is null
  );
$$;

-- Owners/admins can see profiles of people in their orgs and apps. Runtime
-- users see only their own profile.
create or replace function public.can_view_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = (select auth.uid())
    or exists (
      select 1 from public.org_members target
      join public.org_members me on me.org_id = target.org_id
      where target.user_id = p_user_id
        and me.user_id = (select auth.uid())
        and me.role in ('owner', 'admin')
    )
    or exists (
      select 1 from public.app_members target
      where target.user_id = p_user_id
        and public.is_app_admin(target.app_id)
    );
$$;

-- Entitlement of a cloud app (PRD §4.2). Returns
-- {allowed, reason, allowance, used, status, planId}. `used` counts active
-- Runtime Users; the owner is not counted. Callers that add a member check
-- `used + 1 <= allowance` themselves. Reasons: ok, grace, not_found,
-- app_deleted, no_subscription, subscription_inactive, over_allowance.
-- Clients may only ask about apps they administer or belong to.
create or replace function public.app_entitlement(p_app_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_app public.cloud_apps;
  v_sub public.subscriptions;
  v_allowance integer := 0;
  v_used integer := 0;
  v_reason text;
  v_allowed boolean;
  -- JWT role of the PostgREST request; empty for direct database sessions.
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  select * into v_app from public.cloud_apps where id = p_app_id;
  if not found
    or (
      v_role not in ('', 'service_role')
      and not public.is_app_admin(p_app_id)
      and not public.is_app_member(p_app_id)
    )
  then
    return jsonb_build_object('allowed', false, 'reason', 'not_found', 'allowance', 0, 'used', 0);
  end if;

  select count(*) into v_used from public.app_members
  where app_id = p_app_id and status = 'active';

  if v_app.deleted_at is not null then
    return jsonb_build_object('allowed', false, 'reason', 'app_deleted', 'allowance', 0, 'used', v_used);
  end if;

  select * into v_sub from public.subscriptions where app_id = p_app_id;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_subscription', 'allowance', 0, 'used', v_used);
  end if;

  select runtime_user_allowance into v_allowance from public.plans where id = v_sub.plan_id;

  if v_sub.status in ('active', 'trialing') then
    v_allowed := true; v_reason := 'ok';
  elsif v_sub.status = 'past_due'
    and coalesce(v_sub.current_period_end, now()) + interval '7 days' > now() then
    v_allowed := true; v_reason := 'grace';
  else
    v_allowed := false; v_reason := 'subscription_inactive';
  end if;

  if v_allowed and v_used > v_allowance then
    v_allowed := false; v_reason := 'over_allowance';
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'reason', v_reason,
    'allowance', v_allowance,
    'used', v_used,
    'status', v_sub.status,
    'planId', v_sub.plan_id
  );
end;
$$;

-- Append an audit event. Service role only (Edge Functions); clients cannot
-- forge history. Returns the event id.
create or replace function public.audit(
  p_action text,
  p_actor_id uuid default null,
  p_org_id uuid default null,
  p_app_id uuid default null,
  p_target text default null,
  p_details jsonb default '{}'::jsonb,
  p_ip_hash text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_org uuid := p_org_id;
begin
  if v_org is null and p_app_id is not null then
    select org_id into v_org from public.cloud_apps where id = p_app_id;
  end if;
  insert into public.audit_events (actor_id, org_id, app_id, action, target, details, ip_hash)
  values (p_actor_id, v_org, p_app_id, p_action, p_target, coalesce(p_details, '{}'::jsonb), p_ip_hash)
  returning id into v_id;
  return v_id;
end;
$$;

-- Fixed-window rate limit. Returns true while the bucket is under `p_max`
-- hits in the current window of `p_window_seconds`.
create or replace function public.rate_limit(p_bucket text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits as r (bucket, window_start, count)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start + make_interval(secs => p_window_seconds) <= now() then now()
      else r.window_start end,
    count = case
      when r.window_start + make_interval(secs => p_window_seconds) <= now() then 1
      else r.count + 1 end
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

-- Daily counter for service metrics (health, auth, publish, storage, keys).
create or replace function public.metric_increment(p_name text, p_by bigint default 1)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.service_metrics as m (name, day, count)
  values (p_name, current_date, p_by)
  on conflict (name, day) do update set count = m.count + excluded.count;
$$;

revoke all on function public.is_org_member(uuid, text[]) from public, anon;
revoke all on function public.is_app_owner(uuid) from public, anon;
revoke all on function public.is_app_admin(uuid) from public, anon;
revoke all on function public.is_app_member(uuid) from public, anon;
revoke all on function public.can_view_profile(uuid) from public, anon;
revoke all on function public.app_entitlement(uuid) from public, anon;
revoke all on function public.audit(text, uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.metric_increment(text, bigint) from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_new_organization() from public, anon, authenticated;
revoke all on function public.ensure_org_has_owner() from public, anon, authenticated;
revoke all on function public.app_versions_immutable() from public, anon, authenticated;
revoke all on function public.audit_events_append_only() from public, anon, authenticated;

grant execute on function public.is_org_member(uuid, text[]) to authenticated, service_role;
grant execute on function public.is_app_owner(uuid) to authenticated, service_role;
grant execute on function public.is_app_admin(uuid) to authenticated, service_role;
grant execute on function public.is_app_member(uuid) to authenticated, service_role;
grant execute on function public.can_view_profile(uuid) to authenticated, service_role;
grant execute on function public.app_entitlement(uuid) to authenticated, service_role;
grant execute on function public.audit(text, uuid, uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.rate_limit(text, integer, integer) to service_role;
grant execute on function public.metric_increment(text, bigint) to service_role;

-- Table privileges ----------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.cloud_apps enable row level security;
alter table public.app_roles enable row level security;
alter table public.app_members enable row level security;
alter table public.invitations enable row level security;
alter table public.app_versions enable row level security;
alter table public.archive_uploads enable row level security;
alter table public.installations enable row level security;
alter table public.installation_backups enable row level security;
alter table public.credential_envelopes enable row level security;
alter table public.key_grants enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.rate_limits enable row level security;
alter table public.service_metrics enable row level security;
alter table public.desktop_auth_requests enable row level security;

-- Function-only tables: no client grants, no policies.
--   billing_events, rate_limits, service_metrics, desktop_auth_requests.

-- profiles: see self (and people you administer); edit own display name.
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (public.can_view_profile(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- organizations: members read; any user creates (becomes owner); owner/admin
-- rename; owner deletes (blocked while apps exist).
grant select, insert, delete on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;
create policy organizations_select on public.organizations for select to authenticated
  using (public.is_org_member(id) or created_by = (select auth.uid()));
create policy organizations_insert on public.organizations for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy organizations_update on public.organizations for update to authenticated
  using (public.is_org_member(id, array['owner', 'admin']))
  with check (public.is_org_member(id, array['owner', 'admin']));
create policy organizations_delete on public.organizations for delete to authenticated
  using (public.is_org_member(id, array['owner']));

-- org_members: see your own row; owner/admin see and manage the org; only
-- owners touch owner rows. Joining happens through invitations-accept.
grant select, delete on public.org_members to authenticated;
grant update (role) on public.org_members to authenticated;
create policy org_members_select on public.org_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(org_id, array['owner', 'admin']));
create policy org_members_update on public.org_members for update to authenticated
  using (
    public.is_org_member(org_id, array['owner'])
    or (public.is_org_member(org_id, array['admin']) and role <> 'owner')
  )
  with check (
    public.is_org_member(org_id, array['owner'])
    or (public.is_org_member(org_id, array['admin']) and role <> 'owner')
  );
create policy org_members_delete on public.org_members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_org_member(org_id, array['owner'])
    or (public.is_org_member(org_id, array['admin']) and role <> 'owner')
  );

-- cloud_apps: owner/org admins read and change settings; active members read
-- live app basics. Create, delete and owner transfer are Edge Functions.
grant select on public.cloud_apps to authenticated;
grant update (name, backups_enabled, retention_versions, retention_days) on public.cloud_apps to authenticated;
create policy cloud_apps_select on public.cloud_apps for select to authenticated
  using (
    public.is_app_admin(id)
    or (deleted_at is null and public.is_app_member(id))
    or public.is_org_member(org_id, array['owner', 'admin', 'billing'])
  );
create policy cloud_apps_update on public.cloud_apps for update to authenticated
  using (public.is_app_admin(id)) with check (public.is_app_admin(id));

-- app_roles: admins read all roles; a member reads their own role.
grant select on public.app_roles to authenticated;
create policy app_roles_select on public.app_roles for select to authenticated
  using (
    public.is_app_admin(app_id)
    or exists (
      select 1 from public.app_members m
      where m.app_id = app_roles.app_id and m.role_id = app_roles.id
        and m.user_id = (select auth.uid()) and m.status = 'active'
    )
  );

-- app_members: admins read the app's members; a user reads their own rows.
grant select on public.app_members to authenticated;
create policy app_members_select on public.app_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_app_admin(app_id));

-- invitations: admins of the target org/app read and revoke. Invitees accept
-- through invitations-accept with the raw token.
grant select (id, kind, org_id, app_id, email, org_role, role_id, invited_by, created_at,
  expires_at, accepted_at, accepted_by, revoked_at) on public.invitations to authenticated;
grant update (revoked_at) on public.invitations to authenticated;
create policy invitations_select on public.invitations for select to authenticated
  using (
    (kind = 'org' and public.is_org_member(org_id, array['owner', 'admin']))
    or (kind = 'app' and public.is_app_admin(app_id))
  );
create policy invitations_revoke on public.invitations for update to authenticated
  using (
    accepted_at is null and (
      (kind = 'org' and public.is_org_member(org_id, array['owner', 'admin']))
      or (kind = 'app' and public.is_app_admin(app_id))
    )
  )
  with check (
    (kind = 'org' and public.is_org_member(org_id, array['owner', 'admin']))
    or (kind = 'app' and public.is_app_admin(app_id))
  );

-- app_versions: admins see every version; members see published ones.
grant select on public.app_versions to authenticated;
create policy app_versions_select on public.app_versions for select to authenticated
  using (
    public.is_app_admin(app_id)
    or (status = 'published' and public.is_app_member(app_id))
  );

-- archive_uploads: the uploader and app admins read status.
grant select on public.archive_uploads to authenticated;
create policy archive_uploads_select on public.archive_uploads for select to authenticated
  using (user_id = (select auth.uid()) or public.is_app_admin(app_id));

-- installations and backups: the installing user and app admins read.
grant select on public.installations to authenticated;
create policy installations_select on public.installations for select to authenticated
  using (user_id = (select auth.uid()) or public.is_app_admin(app_id));

grant select on public.installation_backups to authenticated;
create policy installation_backups_select on public.installation_backups for select to authenticated
  using (user_id = (select auth.uid()) or public.is_app_admin(app_id));

-- credential_envelopes: metadata only, owner only. Ciphertext, nonce, aad and
-- the wrapped DEK are never readable by clients.
grant select (id, app_id, datasource_id, scope, user_id, kek_version, created_at, updated_at, revoked_at)
  on public.credential_envelopes to authenticated;
create policy credential_envelopes_select on public.credential_envelopes for select to authenticated
  using (public.is_app_owner(app_id));

-- key_grants: app admins see issuance history (no secrets are stored).
grant select on public.key_grants to authenticated;
create policy key_grants_select on public.key_grants for select to authenticated
  using (public.is_app_admin(app_id));

-- plans: signed-in users read active plans.
grant select on public.plans to authenticated;
create policy plans_select on public.plans for select to authenticated
  using (active);

-- subscriptions: app admins and org billing members read.
grant select on public.subscriptions to authenticated;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (
    public.is_app_admin(app_id)
    or exists (
      select 1 from public.cloud_apps a
      where a.id = subscriptions.app_id
        and public.is_org_member(a.org_id, array['owner', 'admin', 'billing'])
    )
  );

-- audit_events: app owner and org owner/admin read. Nobody writes directly.
grant select on public.audit_events to authenticated;
create policy audit_events_select on public.audit_events for select to authenticated
  using (
    (app_id is not null and exists (
      select 1 from public.cloud_apps a
      where a.id = audit_events.app_id and a.owner_id = (select auth.uid())
    ))
    or (org_id is not null and public.is_org_member(org_id, array['owner', 'admin']))
  );

-- The service role keeps full access (Edge Functions).
grant all on all tables in schema public to service_role;
