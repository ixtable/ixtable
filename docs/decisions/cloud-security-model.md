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
  (XChaCha20-Poly1305, Rust). The `credential-envelope` function wraps the
  DEK with the KEK: AES-256-GCM, 96-bit random IV, AAD binding the envelope
  context (`appId|datasourceId[|userId]`), stored as `base64(iv ||
  ciphertext || tag)` plus `kek_version`. The plaintext DEK is not stored.
- KEKs are function secrets `IXTABLE_KEK_V<n>` (32 random bytes, base64) with
  `IXTABLE_KEK_CURRENT_VERSION` for new wraps. Rotation adds a version and
  re-wraps envelopes in the background; old versions stay until no row uses
  them. The KEK never leaves the function runtime.
- `key-grant` returns the unwrapped DEK and the envelope over TLS to an
  authorized installation, records a `key_grants` row and an audit event,
  and sets `expiresAt = now + 24h`. The Runtime decrypts in memory and
  renews with a refreshed session. Grants are rate limited per user.

### Desktop sign-in

Email/password runs in the desktop webview. OAuth uses a browser hand-off with
PKCE (S256): the desktop sends `code_challenge` and `state`, the signed-in
website approves, and the desktop exchanges `state` + `code_verifier` once,
within 10 minutes (`desktop_auth_requests`). The refresh token is stored in
the OS secret store, never in archives or logs.

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
- Function specs for key grants, revocation, bundles and desktop auth are
  added by the agents that build those functions.
