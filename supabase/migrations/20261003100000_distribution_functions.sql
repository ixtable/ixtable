-- ixtable Cloud distribution: transactional helpers for the distribution
-- Edge Functions (publish, versions-resolve, backup-commit,
-- invitations-accept, members-update). Each one runs the check and the write
-- in one transaction under a row lock on the app, so concurrent publishes
-- cannot both move the head and concurrent accepts cannot overrun the
-- runtime-user allowance. Service role only.
--
-- Errors use custom SQLSTATEs that _shared/distribution.ts maps to the API
-- error contract:
--   IX404 not found        IX409 head moved (detail: current head id)
--   IX410 upload/invitation not usable   IX402 entitlement (message: reason)
--   IX403 forbidden        IX422 validation

-- Commits a pending version upload as a published checkpoint and moves the
-- head. `p_check_head` false skips the precondition (explicit overwrite
-- still passes it: the head must be the version being overwritten).
create or replace function public.distribution_commit_version(
  p_app_id uuid,
  p_upload_id uuid,
  p_developer_id uuid,
  p_version text,
  p_check_head boolean,
  p_expected_head uuid,
  p_migrations jsonb,
  p_min_runtime_version text,
  p_security jsonb,
  p_release_notes text,
  p_parent_version_id uuid default null,
  p_resolution text default null,
  p_storage_path text default null,
  p_datasource_kind text default null
)
returns public.app_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.cloud_apps;
  v_upload public.archive_uploads;
  v_row public.app_versions;
begin
  select * into v_app from public.cloud_apps where id = p_app_id for update;
  if not found or v_app.deleted_at is not null then
    raise exception 'App not found' using errcode = 'IX404';
  end if;
  if p_check_head and v_app.head_version_id is distinct from p_expected_head then
    raise exception 'The published head has moved'
      using errcode = 'IX409', detail = coalesce(v_app.head_version_id::text, '');
  end if;

  update public.archive_uploads
     set status = 'committed', committed_at = now()
   where id = p_upload_id
     and kind = 'version'
     and status = 'pending'
     and expires_at > now()
  returning * into v_upload;
  if not found then
    raise exception 'The upload is unknown, expired or already used' using errcode = 'IX410';
  end if;
  -- A fork moves the upload into the new app; otherwise it must belong here.
  if p_storage_path is null and v_upload.app_id <> p_app_id then
    raise exception 'The upload belongs to another app' using errcode = 'IX403';
  end if;

  insert into public.app_versions (
    id, app_id, version, developer_id, archive_sha256, archive_size, storage_path,
    migrations, min_runtime_version, security, release_notes, status,
    parent_version_id, resolution, published_at
  ) values (
    v_upload.id, p_app_id, p_version, p_developer_id, v_upload.expected_sha256,
    v_upload.expected_size, coalesce(p_storage_path, v_upload.storage_path),
    coalesce(p_migrations, '[]'::jsonb), coalesce(p_min_runtime_version, '0.0.0'),
    coalesce(p_security, '{}'::jsonb), coalesce(p_release_notes, ''), 'published',
    p_parent_version_id, p_resolution, now()
  )
  returning * into v_row;

  update public.cloud_apps
     set head_version_id = v_row.id,
         datasource_kind = coalesce(p_datasource_kind, datasource_kind)
   where id = p_app_id;
  return v_row;
exception
  when unique_violation then
    raise exception 'Version % already exists for this app', p_version using errcode = 'IX422';
end;
$$;

-- Records a pending backup upload in its installation's stream.
create or replace function public.distribution_commit_backup(
  p_app_id uuid,
  p_upload_id uuid,
  p_user_id uuid,
  p_installation_id uuid
)
returns public.installation_backups
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.cloud_apps;
  v_upload public.archive_uploads;
  v_row public.installation_backups;
begin
  select * into v_app from public.cloud_apps where id = p_app_id for share;
  if not found or v_app.deleted_at is not null then
    raise exception 'App not found' using errcode = 'IX404';
  end if;
  if not v_app.backups_enabled then
    raise exception 'Backups are not enabled for this app' using errcode = 'IX403';
  end if;
  update public.archive_uploads
     set status = 'committed', committed_at = now()
   where id = p_upload_id
     and app_id = p_app_id
     and user_id = p_user_id
     and kind = 'backup'
     and installation_id = p_installation_id
     and status = 'pending'
     and expires_at > now()
  returning * into v_upload;
  if not found then
    raise exception 'The upload is unknown, expired or already used' using errcode = 'IX410';
  end if;
  insert into public.installation_backups (
    id, app_id, user_id, installation_id, upload_id, storage_path, archive_sha256, archive_size
  ) values (
    v_upload.id, p_app_id, p_user_id, p_installation_id, v_upload.id, v_upload.storage_path,
    v_upload.expected_sha256, v_upload.expected_size
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- Activates (or re-activates) a Runtime User under the app's allowance.
-- Caller holds the app row lock. Raises IX402 with the entitlement reason.
create or replace function public.distribution_activate_member(
  p_app_id uuid,
  p_user_id uuid,
  p_role_id uuid,
  p_invited_by uuid
)
returns public.app_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.app_members;
  v_ent jsonb;
  v_row public.app_members;
begin
  select * into v_existing from public.app_members
   where app_id = p_app_id and user_id = p_user_id;
  if not found or v_existing.status <> 'active' then
    v_ent := public.app_entitlement(p_app_id);
    if not (v_ent ->> 'allowed')::boolean then
      raise exception '%', v_ent ->> 'reason' using errcode = 'IX402';
    end if;
    if (v_ent ->> 'used')::integer + 1 > (v_ent ->> 'allowance')::integer then
      raise exception 'over_allowance' using errcode = 'IX402';
    end if;
  end if;
  insert into public.app_members (app_id, user_id, role_id, status, invited_by, revoked_at)
  values (p_app_id, p_user_id, p_role_id, 'active', p_invited_by, null)
  on conflict (app_id, user_id) do update set
    role_id = excluded.role_id,
    status = 'active',
    revoked_at = null,
    invited_by = coalesce(excluded.invited_by, public.app_members.invited_by)
  returning * into v_row;
  return v_row;
end;
$$;

-- Accepts an invitation by token hash for the signed-in user. Single use:
-- the invitation row is locked and marked accepted in the same transaction
-- that adds the membership.
create or replace function public.distribution_accept_invitation(
  p_token_hash text,
  p_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations;
  v_app public.cloud_apps;
  v_member public.app_members;
  v_org_role text;
begin
  select * into v_inv from public.invitations where token_hash = p_token_hash for update;
  if not found then
    raise exception 'Invitation not found' using errcode = 'IX404';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'This invitation was revoked' using errcode = 'IX410';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'This invitation was already used' using errcode = 'IX410';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invitation has expired' using errcode = 'IX410';
  end if;
  if lower(coalesce(p_email, '')) <> v_inv.email then
    raise exception 'This invitation was sent to another email address' using errcode = 'IX403';
  end if;

  if v_inv.kind = 'org' then
    insert into public.org_members (org_id, user_id, role)
    values (v_inv.org_id, p_user_id, v_inv.org_role)
    on conflict (org_id, user_id) do update set
      role = case when public.org_members.role = 'owner' then 'owner' else excluded.role end
    returning role into v_org_role;
    update public.invitations set accepted_at = now(), accepted_by = p_user_id where id = v_inv.id;
    return jsonb_build_object(
      'kind', 'org', 'invitationId', v_inv.id, 'orgId', v_inv.org_id,
      'userId', p_user_id, 'role', v_org_role
    );
  end if;

  select * into v_app from public.cloud_apps where id = v_inv.app_id for update;
  if not found or v_app.deleted_at is not null then
    raise exception 'App not found' using errcode = 'IX404';
  end if;
  if v_app.owner_id = p_user_id then
    raise exception 'The app owner cannot join as a Runtime User' using errcode = 'IX422';
  end if;
  v_member := public.distribution_activate_member(v_app.id, p_user_id, v_inv.role_id, v_inv.invited_by);
  update public.invitations set accepted_at = now(), accepted_by = p_user_id where id = v_inv.id;
  return jsonb_build_object(
    'kind', 'app', 'invitationId', v_inv.id, 'orgId', v_app.org_id, 'appId', v_app.id,
    'userId', p_user_id, 'roleId', v_member.role_id, 'status', v_member.status
  );
end;
$$;

-- Changes a Runtime User's role and/or status. Re-activation counts against
-- the allowance. Returns the member row.
create or replace function public.distribution_update_member(
  p_app_id uuid,
  p_user_id uuid,
  p_role_id uuid,
  p_status text
)
returns public.app_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.cloud_apps;
  v_member public.app_members;
begin
  select * into v_app from public.cloud_apps where id = p_app_id for update;
  if not found or v_app.deleted_at is not null then
    raise exception 'App not found' using errcode = 'IX404';
  end if;
  select * into v_member from public.app_members
   where app_id = p_app_id and user_id = p_user_id for update;
  if not found then
    raise exception 'Member not found' using errcode = 'IX404';
  end if;
  if p_role_id is not null
    and not exists (select 1 from public.app_roles where app_id = p_app_id and id = p_role_id)
  then
    raise exception 'Unknown role' using errcode = 'IX422';
  end if;
  if p_status = 'active' and v_member.status <> 'active' then
    return public.distribution_activate_member(
      p_app_id, p_user_id, coalesce(p_role_id, v_member.role_id), null
    );
  end if;
  update public.app_members set
    role_id = coalesce(p_role_id, role_id),
    status = coalesce(p_status, status),
    revoked_at = case
      when p_status = 'revoked' and status <> 'revoked' then now()
      else revoked_at end
  where app_id = p_app_id and user_id = p_user_id
  returning * into v_member;
  return v_member;
end;
$$;

revoke all on function public.distribution_commit_version(
  uuid, uuid, uuid, text, boolean, uuid, jsonb, text, jsonb, text, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.distribution_commit_backup(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.distribution_activate_member(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.distribution_accept_invitation(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.distribution_update_member(uuid, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.distribution_commit_version(
  uuid, uuid, uuid, text, boolean, uuid, jsonb, text, jsonb, text, uuid, text, text, text
) to service_role;
grant execute on function public.distribution_commit_backup(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.distribution_activate_member(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.distribution_accept_invitation(text, uuid, text) to service_role;
grant execute on function public.distribution_update_member(uuid, uuid, uuid, text) to service_role;
