# 0007. Password-protected manual runtime bundle

Status: accepted

A manual runtime bundle is the `.ixt` bytes encrypted at rest with Argon2id (32 MiB, 3 iterations, 1 lane) and XChaCha20-Poly1305. AAD is `ixtable.runtime-bundle.v1`. The password never becomes a product account.

Wrong passwords fail closed. An authorized recipient who opens the bundle can copy displayed data and any credentials the Runtime decrypts for that session. The password is a lock on the file, not a DRM system.

Cloud personalized bundles use signatures and envelope keys instead of this password wrapper. A developer may still password-protect a manual export.

The automated proof is `password_bundle_round_trips_and_rejects_wrong_password`.
