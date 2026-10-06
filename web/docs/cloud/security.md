---
sidebar_position: 2
---

# Security model

_What ixtable Cloud protects, how it delivers apps and credentials, and where its protection stops._

ixtable Cloud distributes apps privately to people you invite. It assumes those people are **trusted users**: it controls who receives an app and its credentials, and it records what happened. It cannot stop an authorized user from copying what their own computer can read.

This page describes the design so you can decide what to distribute and how to configure your database.

## Threat model

ixtable Cloud defends against people you did not invite. They cannot list your apps, download an archive, or obtain a credential key. Every table denies access unless a row-level policy grants it. The archive bucket is private, and the website and desktop app reach archives only through short-lived signed links that an Edge Function issues after it checks membership and entitlement.

It does not defend against a runtime user you invited who decides to misuse access. That user runs the app on a computer they control. They can read the data the app shows them, copy the archive they installed, and extract a datasource credential the Runtime decrypted for them. Revoking them stops future access and does not erase what they already have.

| Threat | Protection |
| --- | --- |
| Someone without an invitation | Private by default, row-level security, signed links |
| A changed or forged bundle | Ed25519 signature, expiry, and checksum checked before use |
| A leaked bundle | Per-user fingerprint for attribution |
| A former runtime user | Revocation blocks new bundles and key grants |
| A current runtime user who misuses access | Audit history and fingerprints. No technical prevention |

## Signed and fingerprinted bundles

When a runtime user installs or syncs, ixtable Cloud issues a manifest for the latest published version. The manifest names the app, the version, the archive checksum, the user, their role, the installation, an expiry time, and a **fingerprint**. The fingerprint is an HMAC-SHA256 of the user, version, installation, and issue time under a server secret. ixtable Cloud signs the manifest with its Ed25519 key.

The Runtime pins the ixtable Cloud public key. It checks the signature, the expiry, and the SHA-256 of the downloaded archive before it opens the archive, and it refuses the bundle if any check fails. The Runtime shows who the copy is licensed to. A fingerprint identifies where a leaked copy came from. It does not prevent copying.

## Credential delivery

Datasource credentials use envelope encryption with standard primitives. Studio encrypts the secret on your computer with a random 256-bit data key using XChaCha20-Poly1305. It uploads the ciphertext and the data key. ixtable Cloud wraps the data key with its key-encryption key using AES-256-GCM and stores only the wrapped key. The website never reads ciphertext or keys, and the Credentials tab shows metadata only.

The Runtime asks for a **key grant** after it verifies the bundle. ixtable Cloud checks that the membership is active, the role is valid, the plan is entitled, the device is not revoked, and the app is not deleted. It then returns the data key and the envelope with an expiry of 24 hours. The Runtime decrypts the credential in memory and renews the grant with a refreshed session. Every grant is recorded.

Credentials can be shared by every runtime user of an app, or separate per user. A per-user credential can carry its own database username as well as its password, so each runtime user connects as their own database role. The username is encrypted with the password. Use per-user credentials with the least privilege each user needs. A shared credential reaches every runtime user, and Studio asks you to acknowledge that before you publish.

## Revocation limits

You can revoke a runtime user or a single device. Revocation takes effect for the next request. A revoked user or device cannot download a bundle, sync, or get a key grant.

Revocation does not reach into a computer. A key grant already issued stays valid until it expires, at most 24 hours. A credential the user already decrypted, an archive they copied, or data they exported stays with them. After you revoke someone who had a shared credential, rotate that credential in your database.

## PostgreSQL and runtime roles

The Runtime enforces runtime roles in navigation, queries, forms, reports, dashboards, and actions. A role that may open a form, report, or dashboard may also read the saved queries it shows. That never lets the role change records or run actions.

Dashboard filters and columns are not row or column security. A role that may read a query can run it with any filter values and read every row and column it returns. Row and field rules are not available yet. To limit what a role sees, write a narrower saved query and grant that one. For an app that connects straight to PostgreSQL, runtime roles are not a defense against an authorized user who extracts the database credential. That user can connect with any database client and do whatever the credential allows.

For database-level isolation, create a separate least-privileged database role for each runtime user or group. Grant it only the tables and rows it needs, and deliver it as a per-user credential. ixtable Cloud does not host or back up your PostgreSQL database. Restoring an app archive does not restore PostgreSQL records.

## TLS

You control the TLS settings of your PostgreSQL connection. Use TLS for every connection that leaves a private network. Studio blocks publishing an app whose PostgreSQL connection does not use TLS until you read a warning and confirm it. The published version records that override, and the Versions tab shows it as a non-TLS badge.

## Accounts and desktop sign-in

Accounts use email and password, Google, or Microsoft. The desktop app signs in with email and password directly, or hands off to this website for Google and Microsoft. The hand-off uses PKCE. The desktop app opens a page here with a code challenge, and you approve it while signed in. The desktop app then exchanges its secret verifier for a session. Approve only a request you started. The desktop app keeps its refresh token in the operating system's secret store, never in an archive or a log.

## Audit history

ixtable Cloud records security-relevant events in an append-only audit log. That includes app creation and deletion, role and membership changes, publishing, bundle generation, authentication, key grants, revocations, archive uploads, overwrite and fork resolution, restores, and billing changes that affect access. The app owner and organization owners and admins can read it on the app's Audit history tab. Nobody can edit or delete an event.

## Next steps

- [Getting started with ixtable Cloud](./getting-started)
- [Terms of service](../legal/terms)
- [Privacy policy](../legal/privacy)
