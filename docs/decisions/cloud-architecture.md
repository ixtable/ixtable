# ixtable Cloud architecture

Status: accepted for the control-plane foundation (schema, RLS, shared
function code, local stack, service-qa harness). Distribution, credential,
auth hand-off and billing functions build on it. Covers PRD §4.2, §20–§25,
§27.2, §27.5, Phase 4 and Phase 5. Security model:
[cloud-security-model.md](./cloud-security-model.md).

## Context

ixtable Cloud is the paid layer over the free desktop app: accounts and
organizations, one Developer/Owner per cloud app, Runtime Users with custom
roles, explicit publishing, signed and fingerprinted bundles, encrypted
credential delivery with 24-hour key grants, archive backup and restore,
audit history, and per-app plans. It is not a managed database, a browser
runtime or a sync engine (PRD §4.3). Apps are private by default, with no
public links or anonymous sessions (PRD §21.1).

## Decision

### Supabase is the control plane

| Concern | Supabase piece |
|---|---|
| Metadata | Postgres with row-level security on every table |
| Accounts | Auth: email/password, Google, Microsoft (`azure` provider), invitations |
| Archives | Storage bucket `app-archives` (private, 500 MiB per object) |
| Privileged operations | Edge Functions (Deno) using the service role |

The desktop and the website use supabase-js with the anon key and the user's
JWT, and call `functions/v1/<name>`. The service role key exists only inside
Edge Functions.

### Schema

Migrations: `supabase/migrations/20261003000000_cloud_core.sql` (tables),
`…000100_cloud_policies.sql` (helpers, RLS, grants),
`…000200_cloud_storage_plans.sql` (bucket, storage lockdown, plans).

| Table | Purpose |
|---|---|
| `profiles` | one row per auth user (trigger `handle_new_user`), `is_operator` |
| `organizations`, `org_members` | tenancy; roles owner, admin, billing, member; creator becomes owner (trigger); the last owner cannot leave |
| `cloud_apps` | `org_id`, single `owner_id` (NOT NULL), `document_id`, `datasource_kind` sqlite/postgres, `backups_enabled`, `retention_versions`, `retention_days`, `head_version_id`, soft delete `deleted_at` |
| `app_roles` | custom runtime roles, key `(app_id, id)` where `id` is the desktop role id; `permissions` mirrors `roles.rs` |
| `app_members` | `(app_id, user_id)`, `role_id`, status active/revoked |
| `invitations` | org or app invitation; only `token_hash` (sha256 hex) is stored |
| `app_versions` | published checkpoints; immutable except `status` pending→published/withdrawn and published→withdrawn (trigger `app_versions_immutable`) |
| `archive_uploads` | signed upload sessions (expected size and sha256) |
| `installations` | Runtime installation per device, `revoked_at` |
| `installation_backups` | per-installation backup stream |
| `credential_envelopes` | datasource ciphertext + KEK-wrapped DEK, scope shared or per user |
| `key_grants` | one row per issued key grant (no key material) |
| `plans`, `subscriptions`, `billing_events` | catalog (starter 5, team 25, business 100 runtime users), one subscription per app, webhook idempotency on `event_id` |
| `audit_events` | append-only (trigger blocks UPDATE and DELETE for every role) |
| `rate_limits`, `service_metrics`, `desktop_auth_requests` | function-only operational tables |

SQL helpers (security definer, `search_path = ''`):
`is_org_member(org, roles[] default null)`, `is_app_owner(app)`,
`is_app_admin(app)` (owner or org owner/admin), `is_app_member(app)` (active
Runtime User), `can_view_profile(user)`, `app_entitlement(app) → jsonb
{allowed, reason, allowance, used, status, planId}`, and the service-role-only
`audit(action, actor, org, app, target, details, ip_hash)`,
`rate_limit(bucket, max, window_seconds) → boolean`,
`metric_increment(name, by)`.

### Private by default

- The first migration revokes default table, sequence and function
  privileges from `anon` and `authenticated` (and PUBLIC execute on new
  functions). **A later migration must GRANT explicitly** whatever clients
  may do, and enable RLS with policies. A new table without grants is
  invisible to clients, which is the intended failure mode.
- `anon` has no privileges on any cloud table.
- `authenticated` has `SELECT` on the tables the website reads, filtered by
  RLS, and column-level `UPDATE` only for settings the website edits (app
  name, backups, retention; org name; member role; profile display name;
  invitation revocation). Inserts, deletes, owner transfer, publishing,
  membership changes and every write that needs auditing go through Edge
  Functions.
- Column grants hide secrets: `invitations.token_hash` and the envelope
  ciphertext, nonce, AAD and wrapped DEK are never selectable by clients.
- Storage: a restrictive policy on `storage.objects` denies `anon` and
  `authenticated` any access to `app-archives`. Functions mint signed upload
  and download URLs with the service role.

### Edge Functions

Every function is JSON over `POST` (health also `GET`) with
`Authorization: Bearer <user JWT>`, except `health`, `stripe-webhook` and
`desktop-auth-exchange`, which set `verify_jwt = false` in
`supabase/config.toml` and authenticate in code. Errors are
`{ error: { code, message, details? } }`:

| Code | HTTP |
|---|---|
| UNAUTHENTICATED | 401 |
| ENTITLEMENT_REQUIRED | 402 |
| FORBIDDEN, REVOKED | 403 |
| NOT_FOUND | 404 |
| METHOD_NOT_ALLOWED | 405 |
| VERSION_CONFLICT | 409 |
| TOO_LARGE | 413 |
| VALIDATION | 422 |
| PENDING | 428 |
| RATE_LIMITED | 429 |
| INTERNAL | 500 (no detail leaked) |

Shared code in `supabase/functions/_shared/`:

| Module | Exports |
|---|---|
| `http.ts` | `handler(fn, {methods})`, `HttpError(code, message, details?)`, `json`, `errorResponse`, `preflight`, `corsHeaders`, `readJson`, `bearerToken`, `requireUser(req) → {user, jwt}`, `ERROR_STATUS` |
| `db.ts` | `serviceClient()`, `userClient(jwt)`, `anonClient()`, `env`, `optionalEnv`, `ARCHIVE_BUCKET`, `MAX_ARCHIVE_BYTES` |
| `audit.ts` | `audit({action, actorId, orgId, appId, target, details, req})`, `redactSecrets`, `ipHash` |
| `rateLimit.ts` | `rateLimit`, `enforceRateLimit` (throws RATE_LIMITED), `incrementMetric` |
| `entitlements.ts` | `getEntitlement(appId)`, `requireEntitlement(appId, {adding})` (throws ENTITLEMENT_REQUIRED) |
| `crypto.ts` | Ed25519 sign/verify, `canonicalJson`, `bundleFingerprint`, AES-256-GCM `wrapDek`/`unwrapDek`, `hmacSha256Hex`, `sha256Hex`, `pkceChallenge`, `randomToken`, `timingSafeEqual`, base64 helpers |
| `billing.ts` | `billingProvider()` (`stripe` or `fake`), `verifyStripeSignature`, `signStripePayload`, `buildFakeEvent` |
| `validate.ts` | `str`, `uuid`, `int`, `bool`, `oneOf`, `arr`, `record`, `sha256`, `semver`, `email` (throw VALIDATION) |

CORS echoes only the website origins (`SITE_URL`, local 3001,
`CORS_ALLOWED_ORIGINS`) and the Tauri origins `tauri://localhost`,
`http(s)://tauri.localhost`. The local Kong gateway rewrites the header to
`*`; hosted Supabase passes the function's header through.

npm dependencies of functions are declared in `supabase/functions/package.json`
(bare imports, `deno.json` `nodeModulesDir: "manual"`), and only `db.ts`
imports supabase-js.

### Archives, versions and bundles

Paths: `apps/<appId>/versions/<versionId>.ixt` (developer stream) and
`apps/<appId>/installations/<userId>/<installationId>/<backupId>.ixt`
(installation stream, never merged). Publishing is explicit and carries
`expectedHeadVersionId`; a mismatch is `VERSION_CONFLICT`, resolved by
explicit overwrite or fork (`app_versions.resolution`, `parent_version_id`).
Bundle manifests are `canonicalJson` strings signed with Ed25519; see the
security model for formats.

### Billing

Per-app plans with a runtime-user allowance. `app_entitlement` allows
`active` and `trialing`, and `past_due` for 7 days after the period end;
active Runtime Users must not exceed the allowance (the owner is not
counted). Functions check it with `requireEntitlement(appId, {adding: 1})`
when activating a member, and plain `requireEntitlement` on publish, bundle
download, key grant and backup upload. `stripe-webhook` verifies the
`Stripe-Signature` HMAC and is idempotent through `billing_events.event_id`.
`BILLING_PROVIDER=fake` (local/QA) returns website URLs; the flow completes
with a Stripe-shaped event signed by the same secret.

Webhook ordering (`_shared/billing.ts` `decideSubscriptionEvent`): the
subscription row keeps `provider_event_at` (the newest applied
`event.created`); older events are recorded as `stale` and not applied, and
the update is a compare-and-set on that column. Events about a subscription
other than the app's current one are ignored, except a new purchase, which
replaces it (the old one is canceled with the provider). `invoice.payment_failed`
moves active to `past_due` (grace), `invoice.paid` recovers it. Each event's
`outcome` (applied, ignored, stale, failed) is stored on `billing_events`;
a failed one returns 500 so Stripe retries, and a processed one is
acknowledged as a duplicate. Access-relevant changes are audited as
`billing.subscription_activated|past_due|canceled|inactive`,
`billing.payment_recovered`, `billing.plan_changed`, `billing.cancel_scheduled|reverted`.
A downgrade below the active Runtime Users is allowed and reported as
`over_allowance` until members are revoked. The fake checkout records a
`billing_checkout_sessions` row that `billing-fake-complete` consumes once.
Account deletion purges the caller's apps (soft delete and audit first,
then the rows, since `cloud_apps.owner_id` is `ON DELETE RESTRICT`).
Per-endpoint limits live in `RATE_LIMITS` (`_shared/rateLimit.ts`).
Operations: `docs/ops/`.

### Local stack and secrets

`node scripts/cloud/up.mjs` (`npm run service-qa:up`) starts the stack with
only the services ixtable uses, resets the database, and gates on
`functions/v1/health`. `scripts/cloud/dev-secrets.mjs` writes throwaway
secrets to `supabase/functions/.env.local` (mirrored to `.env`, which
`supabase start` loads; both gitignored). `.env.example` lists every
variable. Google and Microsoft sign-in are configured but disabled locally;
`config.toml` documents how to enable them.

## Consequences

- Clients can never write cloud state directly, so every access-relevant
  change has one audited code path. The cost is an Edge Function per
  mutation.
- New tables and functions are inaccessible until a migration grants them,
  which makes forgotten policies fail closed instead of open.
- Audit rows outlive apps and accounts (no foreign keys), so they hold user
  ids after account deletion; they hold no secrets and IPs only as keyed
  hashes.
- `app_versions` rows cannot be edited even by operators; fixing a bad
  publish means withdrawing it and publishing a new version.
- Local CORS is looser than hosted (gateway `*`). The origin list is unit
  tested instead.

## Evidence

- `web/e2e/service-qa/specs/rls-private-by-default.spec.ts`: anon and
  unrelated users read nothing, Runtime User scope, no client writes or
  privileged RPCs, append-only audit, immutable versions, signed-URL-only
  storage.
- `web/e2e/service-qa/specs/health.spec.ts`: health and error contract.
- `supabase/functions/_shared/*_test.ts` (`npm run service-qa:deno`): crypto
  vectors and Node interoperability, Stripe signatures, CORS, error mapping,
  validators.

## Distribution functions

Status: accepted. Functions `apps-create`, `apps-delete`, `apps-transfer`,
`roles-sync`, `invitations-create`, `invitations-accept`, `members-update`,
`archive-upload-url`, `publish-checkpoint`, `versions-resolve`,
`restore-url`, `bundle-manifest`, `sync-check`, `backup-commit`,
`retention-sweep`. Shared code: `supabase/functions/_shared/distribution.ts`
(pure helpers unit tested in `distribution_test.ts`). Migrations
`20261003100000_distribution_functions.sql` and
`20261003100100_distribution_withdraw.sql` add service-role-only SQL
functions that run each check and write in one transaction under a row lock
on the app: `distribution_commit_version`, `distribution_commit_backup`,
`distribution_accept_invitation`, `distribution_activate_member`,
`distribution_update_member`, `distribution_withdraw_version`. They raise
`IXnnn` SQLSTATEs that `mapDbError` turns into the error contract (IX404
NOT_FOUND, IX409 VERSION_CONFLICT with `details.headVersionId`, IX402
ENTITLEMENT_REQUIRED with `details.reason`, IX403 FORBIDDEN, IX410/IX422
VALIDATION, IX423 VALIDATION with `details {requiresConfirm, installations}`).

### Rules

| Function | Who | Gates | Audit |
|---|---|---|---|
| apps-create `{orgId, name, documentId, datasourceKind?}` → `{app}` | org owner/admin/member (billing 403, outsider 404) | one live app per (org, documentId), else 422 with `details.appId` | app.create |
| apps-delete `{appId, confirm}` → `{appId, deletedAt, subscriptionStatus}` | app owner or org owner | `confirm` = app name; soft delete; revokes members, installations, key grants, pending invitations | app.delete (`billingCancellationRequired`) |
| apps-transfer `{appId, newOwnerId, confirm}` → `{app}` | current owner | new owner is an org owner/admin/member; their Runtime User row is removed | app.transfer |
| roles-sync `{appId, roles:[{id,name,permissions}]}` → `{roles, kept}` | owner | upsert by desktop id; absent roles deleted unless a member or pending invitation uses them (`kept`) | role.sync |
| invitations-create `{kind:"app", appId, email, roleId}` \| `{kind:"org", orgId, email, role}` → `{invitation, acceptUrl, delivery}` | app admin / org owner-admin | revokes older pending invitations for the same email and target | invitation.create |
| invitations-accept `{token}` → `{membership}` | invitee with the verified invited email | single use, 7 days; app: entitlement with room for one more (402) | invitation.accept + member.add / org_member.add |
| members-update `{appId, userId, roleId?, status?}` → `{member}` | app admin | re-activation needs allowance (402) | member.role_change / member.revoke / member.activate |
| archive-upload-url `{appId, kind, size, sha256, installationId?}` → `{uploadId, path, signedUrl, token, expiresAt}` | version: owner; backup: owner or active member, backups enabled | ≤ 500 MB (413), entitlement; backup registers the installation | archive.upload |
| publish-checkpoint (contract fields) → `{version}` | owner | entitlement, head precondition (409), version > head (422), security summary, stored object size | version.publish |
| versions-resolve overwrite / fork / withdraw | owner | see below | version.overwrite / version.fork (+ app.create) / version.withdraw |
| restore-url `{appId, versionId \| backupId}` → `{signedUrl, sha256, size, isPostgres, warning, kind, id, expiresAt}` | versions: owner; backups: owner or the backup's user | 15-minute URL | version.restore / backup.restore |
| bundle-manifest `{appId, installationId, deviceName?}` → `{manifest, signature, archiveUrl, archiveUrlExpiresAt}` | owner or active member (403 FORBIDDEN / REVOKED) | entitlement, installation not revoked or foreign | bundle.generate |
| sync-check `{appId, installedVersionId, installationId}` → `{upToDate, latest}` | same as bundle | records `installed_version_id`, `last_seen_at` | none |
| backup-commit `{appId, uploadId, installationId}` → `{backup}` | owner or active member | backups enabled, entitlement, the caller's own installation and upload | backup.upload |
| retention-sweep `{appId?}` → `{deleted, versions, backups, uploads, desktopAuthRequests}` | service role key (Bearer) or `x-cron-secret` = `CRON_SECRET` | `verify_jwt = false` | retention.sweep |

- **Uploads.** The upload id is also the version or backup id, so the
  storage path is fixed when the URL is minted. Commits check the stored
  object's size (Storage list metadata) against the declared size and mark
  the upload `committed`; a consumed, expired or mismatched upload is 422.
  The signed upload URL refuses a second PUT (no upsert). The server does not
  re-hash archives; the desktop verifies sha256 against the signed manifest.
- **Security summary.** Stored normalized on the version: `{store,
  credentialMode, tls, sslmode, insecureTransportConfirmed(At),
  sharedCredentialAcknowledged, concurrencyPoliciesResolved,
  unresolvedEntities}`. Desktop preflight names are accepted as aliases
  (`insecureOverrideConfirmed`, `sharedCredentialWarningAcknowledged`,
  `entityPoliciesResolved`). A PostgreSQL summary without `credentialMode
  "perUser"` counts as shared. Concurrency policies are required when the
  app has more than one active Runtime User or the plan allows more than one.
  Publishing sets `cloud_apps.datasource_kind` from `store`.
- **versions-resolve.** `overwrite` takes the publish fields plus
  `fromVersionId` (the head from the 409) and publishes with resolution
  `overwrite`. `fork` creates a new app in the same org owned by the caller
  (roles copied; no members or subscription; `documentId` defaults to
  `<documentId>:fork:<newAppId>` because one document links to one live app
  per org) from either the caller's pending upload (moved to the new app's
  path) or a copy of a published `fromVersionId`; returns `{app, version}`.
  `withdraw {versionId, confirm?}` marks a published version withdrawn and,
  when it was the head, moves the head to the most recently published
  remaining version (null when none); withdrawing the last published version
  that installations run needs `confirm: true`. Returns `{version,
  headVersionId, dependentInstallations}`. Withdraw is not entitlement-gated.
- **Manifest.** Exactly the PLAN fields plus `roleName`; the owner gets
  `roleId`, `roleName` and `rolePermissions` null. `expiresAt` is issue time
  plus 24 hours; the archive URL lives 15 minutes.
- **Invitation delivery.** An email with no account gets a Supabase Auth
  invitation (`inviteUserByEmail`, redirect to the accept link); an existing
  account gets a sign-in link (`signInWithOtp`, `shouldCreateUser: false`)
  to the accept link. `delivery` is `invite`, `magic_link` or `none`.
- **Signed URLs** minted inside the Edge runtime use its internal API host
  locally (`http://kong:8000`); `publicUrl` rewrites them to
  `SUPABASE_PUBLIC_URL` when set, else the request's forwarded host.
- **Retention.** Per app: versions beyond `retention_versions` or older than
  `retention_days` are deleted (storage object first, then the row), never
  the head or a version an installation reports as installed. Each
  installation's backup stream follows the same rule but always keeps its
  newest backup. Pending uploads past expiry become `expired`. A full sweep
  also deletes `desktop_auth_requests` expired over an hour ago.
- **Rate limits** (per user, fixed window): apps-create 20/h, apps-delete and
  apps-transfer 10/h, roles-sync 60/h, invitations-create 30/h,
  invitations-accept 20/10 min, members-update 120/h, archive-upload-url
  60/h, publish-checkpoint 30/h, versions-resolve 20/h, restore-url 60/h,
  bundle-manifest 60/h, sync-check 240/h, backup-commit 60/h.

Evidence: `web/e2e/service-qa/specs/{apps-journey,apps,invitations,members,publish,versions,bundle,backup,retention}.spec.ts`
(helpers in `distribution-fixtures.ts`).
