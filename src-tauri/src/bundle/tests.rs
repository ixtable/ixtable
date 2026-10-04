use super::*;

fn meta() -> BundleMeta {
    BundleMeta {
        bundle_id: "b1".into(),
        name: "CRM".into(),
        version: "1.0.0".into(),
        release_notes: "First".into(),
        min_runtime_version: None,
    }
}

#[test]
fn signed_bundle_round_trips() {
    let key = SigningKey::generate(&mut OsRng);
    let bytes = build_bundle(b"archive", &meta(), None, &key).unwrap();
    let signed = verify(&bytes).unwrap();
    assert!(!signed.header.flags.encrypted);
    assert_eq!(signed.archive_bytes(None).unwrap(), b"archive");
    assert_eq!(signed.header.version, "1.0.0");
}

#[test]
fn password_bundle_round_trips_and_rejects_wrong_password() {
    let key = SigningKey::generate(&mut OsRng);
    let bytes = build_bundle(b"secret archive", &meta(), Some("hunter22"), &key).unwrap();
    assert!(!bytes.windows(14).any(|w| w == b"secret archive"));
    let signed = verify(&bytes).unwrap();
    assert!(signed.header.flags.encrypted);
    assert_eq!(
        signed.archive_bytes(Some("hunter22")).unwrap(),
        b"secret archive"
    );
    assert_eq!(
        signed.archive_bytes(Some("wrong")).unwrap_err().code,
        "BUNDLE_PASSWORD"
    );
    assert_eq!(
        signed.archive_bytes(None).unwrap_err().code,
        "BUNDLE_PASSWORD_REQUIRED"
    );
}

#[test]
fn tampering_fails_signature() {
    let key = SigningKey::generate(&mut OsRng);
    let bytes = build_bundle(b"archive", &meta(), None, &key).unwrap();
    // Header byte (inside the JSON), payload byte, and signature byte.
    let header_at = 14 + 5;
    let payload_at = bytes.len() - 64 - 2;
    for at in [header_at, payload_at, bytes.len() - 1, 0] {
        let mut tampered = bytes.clone();
        tampered[at] ^= 0x01;
        assert_eq!(
            verify(&tampered).unwrap_err().code,
            "BUNDLE_SIGNATURE",
            "byte {at}"
        );
    }
    assert_eq!(
        verify(&bytes[..bytes.len() - 1]).unwrap_err().code,
        "BUNDLE_SIGNATURE"
    );
    // Re-signing a modified header with another key changes the signer.
    let other = SigningKey::generate(&mut OsRng);
    let resigned = verify(&build_bundle(b"archive", &meta(), None, &other).unwrap()).unwrap();
    assert_ne!(
        resigned.header.signer_public_key,
        verify(&bytes).unwrap().header.signer_public_key
    );
}

#[test]
fn runtime_compat_and_versions() {
    let key = SigningKey::generate(&mut OsRng);
    let mut m = meta();
    m.min_runtime_version = Some("99.0.0".into());
    let signed = verify(&build_bundle(b"a", &m, None, &key).unwrap()).unwrap();
    assert_eq!(
        check_runtime_compat(&signed.header, APP_VERSION)
            .unwrap_err()
            .code,
        "BUNDLE_INCOMPATIBLE"
    );
    assert!(check_runtime_compat(&signed.header, "99.0.1").is_ok());
    assert_eq!(
        parse_version("Version", "1.0").unwrap_err().code,
        "INVALID_VERSION"
    );
}

#[test]
fn signing_key_is_persistent_and_private() {
    let dir = std::env::temp_dir().join(format!("ixtable-key-{}", Uuid::new_v4()));
    let first = signing_key(&dir).unwrap();
    let second = signing_key(&dir).unwrap();
    assert_eq!(first.to_bytes(), second.to_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("keys").join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn kdf_parameters_from_the_header_are_capped() {
    let base = EncryptionParams {
        kdf: "argon2id".into(),
        memory_kib: KDF_MEMORY_KIB,
        iterations: KDF_ITERATIONS,
        parallelism: KDF_PARALLELISM,
        salt: B64.encode([7u8; 16]),
        cipher: "xchacha20poly1305".into(),
        nonce: B64.encode([0u8; 24]),
    };
    assert!(derive_key("pw", &base).is_ok());
    for params in [
        EncryptionParams { memory_kib: 256 * 1024 + 1, ..base.clone() },
        EncryptionParams { memory_kib: 1 << 20, ..base.clone() },
        EncryptionParams { iterations: 5, ..base.clone() },
        EncryptionParams { parallelism: 5, ..base.clone() },
    ] {
        assert_eq!(derive_key("pw", &params).unwrap_err().code, "BUNDLE_INCOMPATIBLE");
    }
}

#[test]
fn decrypted_archive_scratch_files_never_persist() {
    let scratch = std::env::temp_dir().join(format!("ixtable-scratch-{}", Uuid::new_v4()));
    assert!(read_archive_bytes(b"not an archive", &scratch).is_err());
    let doc = archive::create_document("Scratch").unwrap();
    let bytes = archive_bytes(&doc, &scratch).unwrap();
    assert_eq!(
        read_archive_bytes(&bytes, &scratch).unwrap().metadata.document_id,
        doc.metadata.document_id
    );
    assert_eq!(fs::read_dir(&scratch).unwrap().count(), 0);
    fs::remove_dir_all(scratch).unwrap();
}
