# PRD: Cloud Publishing, Authentication & RBAC

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the paid control-plane workflow for private application publishing, authenticated Runtime access, invitations, Runtime RBAC, personalized bundle delivery, and credential/key grants.

## Trust model

ixtable Cloud controls:

- identity/authentication;
- cloud application membership;
- runtime role assignment;
- published application versions;
- entitlement to retrieve bundles/updates;
- signed personalized bundle generation/delivery;
- credential/key-grant issuance;
- cloud audit metadata.

It does **not** make an authorized runtime machine trusted against its owner.

Runtime users are trusted recipients of the application capabilities their role grants.

## Identity model

MVP supports:

- email/password login;
- Google login;
- Microsoft login;
- organizations;
- invitations;
- one Developer/Owner per cloud application;
- Runtime Users.

A user may belong to multiple organizations/apps with independent memberships.

The website is control-plane/account UI only; it does not execute `.ixt` applications.

## Application membership

A cloud application has exactly one Developer/Owner in MVP.

Runtime membership records include:

- user identity;
- application identity;
- assigned runtime role;
- invitation/active/revoked state;
- timestamps/audit source.

Invitation acceptance must be bound to the intended authenticated identity or an explicit safe transfer flow.

## Publishing model

Publishing is an explicit state transition from a local checkpoint to an immutable published version.

Autosave, cloud backup, or uploading a checkpoint never publishes implicitly.

Each published version has immutable metadata including:

- cloud application ID;
- source `document_id`;
- application version;
- archive/checkpoint digest;
- config/schema compatibility versions;
- migration set/checksums;
- created/published timestamp;
- publisher identity;
- status (active/superseded/withdrawn where supported).

A published version's bytes/definition are immutable. Corrections create a new published version.

## Publish validation

Publish is blocked by:

- invalid archive/config/design schema;
- dangling dependencies;
- invalid runtime permissions;
- missing required datasource/credential references;
- migration history/checksum inconsistencies;
- unsupported runtime compatibility;
- archive over cloud size limit;
- unresolved shared-entity concurrency policy required by parent PRD;
- other blocking validation from subsystem PRDs.

Validation should return a complete actionable error set where practical.

## Private discovery/distribution

Cloud applications are private by default.

Only an authenticated, active, entitled member may:

- discover the application in Runtime;
- request a personalized bundle;
- retrieve eligible updates;
- request credential/key grants.

Object storage URLs/tokens must be time-limited or otherwise scoped so possession of a stale URL does not create durable unauthorized public access.

## Personalized bundle

The service derives a runtime bundle from an immutable published version and binds delivery metadata to:

- application;
- published version;
- runtime user;
- runtime role/permission snapshot or role reference;
- bundle issuance identifier;
- expiry/authorization metadata where applicable.

Bundles are cryptographically signed by ixtable's release/distribution signing mechanism.

Runtime verifies signature and expected identity/version before activation.

User fingerprinting is an attribution/control mechanism, not protection against byte copying by an authorized recipient.

## RBAC

### Role model

Developer defines custom Runtime roles.

Roles grant access to application-level capabilities/objects such as:

- navigation targets;
- forms;
- reports;
- dashboards;
- saved-query-backed views as exposed by application objects;
- actions.

Field-level and row-level ixtable authorization are not part of MVP.

### Enforcement

Authorization is enforced at every Runtime object/action entry point.

UI hiding is convenience only.

Every action checks both:

- permission to invoke the action;
- permission/capability for protected target objects/mutations.

Local cached authorization may support offline/temporary operation only according to the key-grant/renewal policy defined by the parent product contract.

## Credential/key-grant delivery

Protected datasource credentials are referenced from app definitions by opaque credential reference.

Cloud delivery must:

- authenticate user/device/session as required;
- verify active app membership/role and paid entitlement;
- issue only credentials required for that application/runtime context;
- encrypt/wrap material using a reviewed design;
- use finite authorization/grant lifetime;
- prevent plaintext storage in archive/config/logs/support tooling;
- record issuance/revocation-relevant audit metadata.

The current parent PRD expects periodic authorization renewal on a 24-hour window. Exact grant token/key mechanics require a security ADR and review.

## Revocation semantics

Revocation immediately blocks:

- new bundle issuance;
- update retrieval;
- new credential/key grants;
- control-plane access for that application.

Revocation cannot guarantee deletion of data/credentials already accessible on an authorized user's machine.

Runtime behavior after a cached grant expires must fail closed for capabilities requiring that grant while preserving local data integrity.

## Audit

Cloud audit records security/commercially relevant events such as:

- invitation issued/accepted/revoked;
- role changed;
- publish;
- bundle issued;
- credential/key grant issued/denied;
- restore initiated;
- entitlement-related access denial.

Audit records contain IDs and safe metadata, never protected secret values.

## Acceptance criteria

- Unauthorized/non-member user cannot discover private app metadata beyond unavoidable generic service responses.
- Revoked member cannot obtain new bundles, updates, or key grants.
- Stale direct object invocation cannot bypass RBAC.
- Role change affects subsequent authorization/grant evaluation according to documented cache lifetime.
- Autosave/upload never creates a published version.
- Published version content is immutable.
- Bundle signature/identity mismatch fails before activation.
- Credential reference values never resolve to plaintext in ordinary archive/config/log output.
- Expired/revoked grants fail closed without corrupting local runtime state.
- Audit history identifies who published/invited/revoked without exposing secrets.

## Non-goals

- OIDC/enterprise SSO in MVP;
- multiple developers per cloud application;
- public/anonymous apps;
- row/field-level ixtable permissions;
- hiding accessible data/credentials from a malicious authorized runtime user;
- cloud execution of the application.
