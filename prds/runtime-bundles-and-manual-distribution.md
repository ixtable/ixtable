# PRD: Runtime Bundles & Manual Distribution

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Allow free users to distribute locked runtime-only application bundles manually without requiring ixtable Cloud.

## Bundle properties

A runtime-only bundle:

- contains the application definition required by Runtime;
- cannot be opened in Studio through the normal product flow;
- is versioned;
- may be password protected;
- may initialize an embedded SQLite installation on first open;
- may instead use developer-supplied PostgreSQL.

This is convenience/access control, not DRM against an authorized recipient or an Apache-2.0 fork.

## Password protection

- Use established cryptographic libraries only.
- Derive encryption keys with an approved password KDF.
- Authenticate encrypted content.
- Never store plaintext password.
- Wrong passwords fail without leaking decrypted partial content.

## SQLite installation semantics

- Bundled SQLite data initializes an installation once.
- Subsequent runtime data belongs to that installation.
- Manual definition updates preserve installation-local records/attachments.
- Declared migrations upgrade local state.
- Rollback must respect migration compatibility.

## Manual updates

- Developer exports a newer runtime bundle.
- User imports/opens it as an update to an existing installation.
- Validate application identity, version, compatibility, and migration path.
- Activation is atomic.
- Failed update keeps the prior working version.

## Acceptance criteria

- Recipient can run authorized bundle without Studio access or cloud login.
- Password-protected bundle fails closed on wrong password/corruption.
- Definition-only update preserves local SQLite data.
- Failed migration/update restores previous runtime version.
- Application identity prevents accidentally applying a bundle from another app.

## Non-goals

- remote revocation;
- automatic update delivery;
- user fingerprinting;
- centralized audit;
- strong protection from a malicious authorized recipient.
