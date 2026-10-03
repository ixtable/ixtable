-- ixtable Cloud: credential envelopes, key grants and desktop sign-in
-- hand-off (PRD §21.3, §25). Functions: credential-envelope, credential-delete,
-- key-grant, devices-revoke, desktop-auth-approve, desktop-auth-exchange.
-- Security model: docs/decisions/cloud-security-model.md.

-- Credential envelopes ------------------------------------------------------
-- One active envelope per target (app, datasource, user|shared). Uploading a
-- new one supersedes the old row: its metadata stays for attribution (key
-- grants point at it) but its secret material is erased. Deleting a
-- credential (credential-delete) erases it the same way and sets revoked_at.

alter table public.credential_envelopes
  add column superseded_at timestamptz,
  -- Id of the envelope that replaced this one (no FK: written before it exists).
  add column superseded_by uuid,
  add column revoked_by uuid references auth.users (id) on delete set null;

alter table public.credential_envelopes
  drop constraint credential_envelopes_app_id_datasource_id_user_id_key;

create unique index credential_envelopes_active_idx
  on public.credential_envelopes (app_id, datasource_id, user_id) nulls not distinct
  where superseded_at is null and revoked_at is null;

create index credential_envelopes_app_idx on public.credential_envelopes (app_id, datasource_id);

-- Retired rows never keep secret material.
alter table public.credential_envelopes
  add constraint credential_envelopes_retired_erased check (
    (superseded_at is null and revoked_at is null)
    or (ciphertext = '' and nonce = '' and aad = '' and wrapped_dek = '')
  );

grant select (superseded_at, superseded_by, revoked_by)
  on public.credential_envelopes to authenticated;

-- Atomically supersedes the active envelope of a target and inserts the new
-- one. Service role only (credential-envelope). Returns {id, replacedId}.
create or replace function public.credential_envelope_put(
  p_app_id uuid,
  p_datasource_id text,
  p_scope text,
  p_user_id uuid,
  p_ciphertext text,
  p_nonce text,
  p_aad text,
  p_wrapped_dek text,
  p_kek_version integer,
  p_created_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_old uuid;
begin
  -- Serialize concurrent uploads for the same target.
  perform pg_advisory_xact_lock(
    hashtextextended(p_app_id::text || '|' || p_datasource_id || '|' || coalesce(p_user_id::text, ''), 0)
  );
  update public.credential_envelopes
  set superseded_at = now(), superseded_by = v_id,
      ciphertext = '', nonce = '', aad = '', wrapped_dek = ''
  where app_id = p_app_id
    and datasource_id = p_datasource_id
    and user_id is not distinct from p_user_id
    and superseded_at is null
    and revoked_at is null
  returning id into v_old;

  insert into public.credential_envelopes (
    id, app_id, datasource_id, scope, user_id, ciphertext, nonce, aad,
    wrapped_dek, kek_version, created_by
  ) values (
    v_id, p_app_id, p_datasource_id, p_scope, p_user_id, p_ciphertext, p_nonce, p_aad,
    p_wrapped_dek, p_kek_version, p_created_by
  );
  return jsonb_build_object('id', v_id, 'replacedId', v_old);
end;
$$;

revoke all on function public.credential_envelope_put(uuid, text, text, uuid, text, text, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.credential_envelope_put(uuid, text, text, uuid, text, text, text, text, integer, uuid)
  to service_role;

-- Key grants ----------------------------------------------------------------
-- `kind` is issue (first grant for the installation and datasource) or renew
-- (a non-expired grant already existed). The DEK is delivered once, in the
-- key-grant response, so used_at is the delivery time.

alter table public.key_grants
  add column kind text not null default 'issue' check (kind in ('issue', 'renew')),
  add column used_at timestamptz;

create index key_grants_installation_idx
  on public.key_grants (installation_id, datasource_id, expires_at desc);

-- Desktop sign-in hand-off --------------------------------------------------
-- The website creates an approved request (desktop-auth-approve); the desktop
-- redeems it once with the PKCE verifier (desktop-auth-exchange) within five
-- minutes. Five wrong verifiers invalidate the request.

alter table public.desktop_auth_requests
  alter column expires_at set default now() + interval '5 minutes',
  add column failed_attempts integer not null default 0;

create index desktop_auth_requests_user_idx on public.desktop_auth_requests (user_id);

-- No client grants: desktop_auth_requests stays function-only.
grant all on public.credential_envelopes, public.key_grants, public.desktop_auth_requests to service_role;
