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
