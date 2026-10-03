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
