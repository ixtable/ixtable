-- ixtable Cloud distribution: withdraw a published checkpoint (rollback).
-- Used by versions-resolve {action:"withdraw"}. Under a lock on the app row:
-- the version becomes withdrawn (immutable otherwise), and when it was the
-- head, the head moves to the most recently published remaining version (or
-- none). Withdrawing the last published version while installations still
-- run it needs p_confirm (else IX423, detail = number of installations).
-- Service role only.
create or replace function public.distribution_withdraw_version(
  p_app_id uuid,
  p_version_id uuid,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.cloud_apps;
  v_version public.app_versions;
  v_previous uuid;
  v_dependents integer;
  v_head uuid;
begin
  select * into v_app from public.cloud_apps where id = p_app_id for update;
  if not found or v_app.deleted_at is not null then
    raise exception 'App not found' using errcode = 'IX404';
  end if;
  select * into v_version from public.app_versions
   where id = p_version_id and app_id = p_app_id for update;
  if not found then
    raise exception 'Version not found' using errcode = 'IX404';
  end if;
  if v_version.status <> 'published' then
    raise exception 'Only a published version can be withdrawn' using errcode = 'IX422';
  end if;

  select id into v_previous from public.app_versions
   where app_id = p_app_id and status = 'published' and id <> p_version_id
   order by published_at desc nulls last, created_at desc
   limit 1;
  select count(*) into v_dependents from public.installations
   where app_id = p_app_id and installed_version_id = p_version_id and revoked_at is null;
  if v_previous is null and v_dependents > 0 and not coalesce(p_confirm, false) then
    raise exception 'Installations run the only published version; confirm to withdraw it'
      using errcode = 'IX423', detail = v_dependents::text;
  end if;

  update public.app_versions set status = 'withdrawn'
   where id = p_version_id
  returning * into v_version;
  v_head := v_app.head_version_id;
  if v_head is not distinct from p_version_id then
    v_head := v_previous;
    update public.cloud_apps set head_version_id = v_head where id = p_app_id;
  end if;
  return jsonb_build_object(
    'version', to_jsonb(v_version),
    'headVersionId', v_head,
    'dependentInstallations', v_dependents
  );
end;
$$;

revoke all on function public.distribution_withdraw_version(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.distribution_withdraw_version(uuid, uuid, boolean) to service_role;
