# 0008. Signed personalized bundles and envelope encryption

Status: accepted for design review. Independent security review is still required before Phase 4 implementation commitment.

## Signature

ixtable signs `ixtable.bundle.v1|{app_id}|{user_id}|{sha256(archive)}` with Ed25519. Runtime verifies the signature and the archive digest before extract. A user id in the signed payload is a fingerprint for attribution. It does not stop an authorized user from copying files.

Tampered archives and swapped user ids fail closed.

## Envelope

Datasource credentials are never stored as plaintext in an unencrypted archive entry.

1. Generate a 32-byte data key.
2. Encrypt credential json with xchacha20-poly1305 and aad `ixtable.credential.v1`.
3. Derive a wrap key from the cloud wrapping secret using hkdf-sha256 and info `ixtable.envelope.kek.v1`.
4. Encrypt the data key with that wrap key and aad `ixtable.dek.v1`.
5. After login, Runtime asks Cloud for a 24-hour one-time wrap-key grant, unwraps the data key, then decrypts credentials.

Revocation blocks the next grant. It cannot erase secrets a malicious authorized user already read. Shared PostgreSQL passwords reduce revocation quality. Per-user database roles are the isolation tool.

No custom constructions. The spike uses `ed25519-dalek`, `chacha20poly1305`, `hkdf`, `argon2`, and `sha2`.

The automated proof is `personalized_signature_binds_user_and_archive` together with `envelope_requires_the_kek`.
