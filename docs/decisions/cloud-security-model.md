# ixtable Cloud security model

Status: accepted as the design baseline. It must pass an independent security
review before public launch (PRD §21.3, Phase 4 exit criteria). Covers PRD
§20.2, §21, §23, §25, §27.2. Architecture:
[cloud-architecture.md](./cloud-architecture.md).

## Context

ixtable distributes desktop applications to trusted Runtime Users. The
Runtime runs on machines the developer does not control, and with PostgreSQL
it talks to the developer's database directly. The cloud therefore cannot
promise secrecy against an authorized user. It can promise that unauthorized
people get nothing, that authorized access is attributable, and that revoked
users cannot obtain new bundles or keys.

## Threat model

| Actor | Can | Cannot (by design) |
|---|---|---|
| Anonymous internet | call `health`, `stripe-webhook` (signature required), `desktop-auth-exchange` (needs the PKCE verifier) | read any table or storage object, discover apps |
| Signed-in user with no membership | read own profile and the plan catalog | read or infer other orgs, apps, versions, members, envelopes, grants, audit, billing |
| Runtime User | read app basics, own role, own membership, own installations and backups, published versions; request bundles and key grants while active and entitled | read other users, envelopes, grants, subscriptions, audit; change any cloud row directly |
| Malicious Runtime User (authorized) | copy the archive, read displayed data, extract the decrypted datasource credential from process memory, keep using a credential they already obtained | evade fingerprint attribution in bundles they downloaded; obtain new grants after revocation |
| App owner / org admin | manage their apps, members, invitations, settings; read audit for their apps | read envelope ciphertext or wrapped DEKs, forge audit rows, edit published versions |
| Operator (`profiles.is_operator`) | diagnose through `admin-support`, which returns no secrets | read secrets through PostgREST (operators get no extra RLS) |
| Compromised website session | act as that user within the rules above | escalate beyond the user's RLS scope |

### Trusted-user limits (PRD §20.2, §21.2, §21.3)

- Runtime RBAC protects navigation, queries, forms, reports and actions in
  the official Runtime. It is not a defense against a user who extracts a
  valid PostgreSQL credential and connects directly. Strong isolation needs
  per-user, least-privileged database credentials and database permissions
  set by the developer. Per-user envelopes (`scope = 'user'`) exist for this;
  shared credentials require an acknowledged warning recorded in the version's
  `security` summary.
- Fingerprinting (HMAC over user, version, installation and issue time, in a
  signed manifest) gives attribution. It does not prevent copying.
- Revocation stops future bundles and key grants. It cannot erase a
  credential or archive a malicious user already obtained; the developer
  must rotate the database credential.
- Non-TLS PostgreSQL is allowed only after an explicit developer override,
  recorded in the version's security summary and shown before publishing.

## Decision

### Authorization

- RLS on every table, explicit grants only (see the architecture record).
  Security-definer helpers use `search_path = ''` and read only
  `auth.uid()`; the service-role-only functions (`audit`, `rate_limit`,
  `metric_increment`) have execute revoked from clients.
- Every privileged action is an Edge Function that checks, in order:
  authentication (`requireUser`), input (`validate.ts`), rate limit, role
  (owner/admin/member and status), installation not revoked, app not deleted,
  entitlement (`requireEntitlement`), then acts and writes an audit event.
- `audit_events` is append-only for every role, including the service role.

### Bundle signing

- Ed25519 via WebCrypto. The private key is the function secret
  `IXTABLE_CLOUD_SIGNING_KEY` (PKCS8 DER, base64). The desktop pins the
  public key at build time (raw 32 bytes = last 32 bytes of the SPKI DER);
  dev and test builds may override it with `IXTABLE_CLOUD_PUBLIC_KEY` (SPKI
  base64) or `IXTABLE_CLOUD_PUBLIC_KEY_RAW`.
- The manifest is serialized with `canonicalJson` (sorted keys, no
  whitespace) and the signature covers exactly those UTF-8 bytes. The
  manifest string is transmitted as is, so the verifier never
  re-serializes. The Runtime verifies signature, expiry, and the archive
  sha256 before using any byte, and fails closed.
- Rotation: publish a new desktop build with both keys pinned, switch the
  secret, then drop the old key in a later build. A leaked signing key lets
  an attacker forge manifests for builds that pin it; rotation requires a
  desktop update.

### Credential envelopes

- Studio encrypts the datasource secret with a random 256-bit DEK
  (XChaCha20-Poly1305, Rust). The owner-only `credential-envelope` function
  checks the inputs (base64; 24-byte nonce, ciphertext of 17 bytes to
  64 KiB, aad up to 1 KiB, 32-byte DEK) and wraps the DEK with the KEK:
  AES-256-GCM, 96-bit random IV, AAD `appId|datasourceId|scope|userId`
  (`userId` empty for shared), stored as `base64(iv || ciphertext || tag)`
  plus `kek_version`. A row copied to another target fails to unwrap. The
  plaintext DEK is not stored or logged.
- A target (app, datasource, user or shared) has one active envelope
  (partial unique index). A new upload runs `credential_envelope_put`, which
  marks the old row `superseded_at`/`superseded_by` and erases its ciphertext,
  nonce, aad and wrapped DEK in the same transaction; a check constraint
  keeps retired rows empty. The metadata stays so key grants remain
  attributable to the credential they delivered.
- Per-user envelopes (`scope = 'user'`) need the target to be an active
  member (or the owner). `key-grant` prefers the caller's per-user envelope
  over the shared one.
- `credential-delete` (owner) revokes the active envelopes of a datasource
  (or one scope/user), erases their secrets and revokes their live grants;
  later grants for it return `NOT_FOUND`.
- KEKs are function secrets `IXTABLE_KEK_V<n>` (32 random bytes, base64) with
  `IXTABLE_KEK_CURRENT_VERSION` for new wraps. Rotation adds a version and
  re-wraps envelopes in the background; old versions stay until no row uses
  them. The KEK never leaves the function runtime.
- Clients can read only envelope metadata, and only the app owner. Every
  client role gets `42501` selecting `ciphertext`, `nonce`, `aad`,
  `wrapped_dek` or `*`.

### Key grants

- `key-grant` checks, in order: session, input, rate limit (30 per hour per
  user and app, `429 RATE_LIMITED`), live app (`NOT_FOUND` when missing or
  deleted), owner or membership (`NOT_FOUND` without one, `REVOKED` when
  revoked), the caller's own installation (`NOT_FOUND`, or `REVOKED` when
  revoked), entitlement (`402 ENTITLEMENT_REQUIRED` with the reason), then the
  envelope (`NOT_FOUND`).
- It returns the unwrapped DEK and the envelope over TLS, records a
  `key_grants` row (`kind` issue or renew, `used_at` = delivery time,
  `expires_at` = issue + 24 h, `renewed_from`) and audits `key.issue`, or
  `key.renew` when a live grant already existed for the installation and
  datasource. Grant ids are single-use: a renewal is a new grant. The
  Runtime decrypts in memory and renews with a refreshed session.
- `devices-revoke` lets app admins revoke any installation and a Runtime User
  revoke their own. It sets `revoked_at`/`revoked_by`, revokes the
  installation's live grants and audits `credential.revoke`. Installation ids
  come from the desktop, so a revoked person could register a new one;
  revoking the membership (`members-update`) is what cuts a person off.
  `bundle-manifest` must refuse revoked installations too.

### Desktop sign-in

Email/password runs in the desktop webview. OAuth uses a browser hand-off with
PKCE (S256):

1. The desktop opens `<site>/desktop-auth?code_challenge=…&state=…`.
2. The signed-in website calls `desktop-auth-approve` `{codeChallenge,
   state}`. This stores a `desktop_auth_requests` row bound to the user,
   approved now, expiring in 5 minutes (audit `auth.desktop_approve`).
   Approving the same state and challenge again is idempotent; any other
   reuse of a state is refused.
3. The desktop polls `desktop-auth-exchange` `{state, codeVerifier}` (no
   JWT). It gets `428 PENDING` until approval, then one session. The
   function checks `base64url(sha256(verifier)) == challenge` in constant
   time, consumes the row with a conditional update (single use), and mints
   the session without the user's password: Auth admin `generateLink`
   (magic link) followed by a server-side `verifyOtp` with the token hash.
   Errors: `404` with reason `consumed` or `expired`, `403` with reason
   `verifier_mismatch` (five failures invalidate the request), `429` (120
   requests per minute per IP hash). Audit `auth.desktop_exchange`.

The refresh token is stored in the OS secret store, never in archives or
logs. Like any device-authorization flow, a user can be phished into
approving an attacker's request; the approval page must say which app is
signing in and to approve only a sign-in they just started.

### Secrets and logging

- Production secrets live in the Supabase secret store, never in the
  repository; `supabase/functions/.env.example` lists names only. Local
  values come from `scripts/cloud/dev-secrets.mjs` and are gitignored.
- Functions never return internal error text (`INTERNAL` only). Audit
  details pass through `redactSecrets`; client IPs are stored as keyed
  hashes. service-qa outputs are redacted the same way.

## Consequences

- An authorized but malicious user can always leak what they are allowed to
  see. The product and the commercial terms must say so.
- Losing a KEK makes its envelopes unrecoverable; developers must re-upload
  credentials. KEKs need backups in the secret manager.
- A 24-hour grant means revocation takes effect at the next renewal for
  credentials already in memory.
- Storage objects are reachable only through short-lived signed URLs, so a
  leaked URL is usable until it expires.

## Evidence

- `web/e2e/service-qa/specs/rls-private-by-default.spec.ts` (authorization,
  append-only audit, immutable versions, storage lockdown, privileged RPCs).
- `supabase/functions/_shared/crypto_test.ts` (Ed25519 with Node-generated
  keys, AES-GCM wrong key/AAD/tamper rejection, KEK versions, HMAC and PKCE
  vectors) and `billing_test.ts` (Stripe signature tolerance and secrets).
- `web/e2e/service-qa/specs/credentials.spec.ts` (owner-only upload,
  validation, supersede and erase, secrets unreadable for every role),
  `key-grant.spec.ts` (XChaCha20-Poly1305 round trip with the granted DEK,
  24-hour expiry, issue/renew, per-user preference, non-member, revoked
  member, deleted app, entitlement, rate limit), `revocation.spec.ts`
  (device revocation, self-service limits, credential deletion) and
  `desktop-auth.spec.ts` (pending, working session, single use, wrong
  verifier, expiry, approval rules).
- `supabase/functions/_shared/credentials_test.ts` (AAD binding, input
  checks, grant expiry, PKCE vectors).
