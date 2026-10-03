use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde_json::json;

const CONF: &str = include_str!("../../tauri.conf.json");
// Signed with the committed public key's private half by `tauri signer sign`
// (the same code path `tauri build` uses for updater artifacts).
const PAYLOAD: &[u8] = include_bytes!("fixtures/payload.bin");
const SIGNATURE: &str = include_str!("fixtures/payload.bin.sig");
// The same payload signed by an unrelated key.
const OTHER_KEY_SIGNATURE: &str = include_str!("fixtures/payload.other-key.sig");

fn conf() -> Value {
    serde_json::from_str(CONF).unwrap()
}

fn pubkey() -> String {
    conf()["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Mirrors tauri-plugin-updater's `verify_signature`: base64 → minisign text,
/// then `PublicKey::verify(data, sig, true)` (legacy non-prehashed signatures allowed).
fn plugin_verify(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let text = |b64: &str| {
        String::from_utf8(STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let key = PublicKey::decode(&text(pubkey_b64)?).map_err(|e| e.to_string())?;
    let sig = Signature::decode(&text(signature_b64)?).map_err(|e| e.to_string())?;
    key.verify(data, &sig, true).map_err(|e| e.to_string())
}

#[test]
fn channels_parse_from_their_names_only() {
    for channel in [UpdateChannel::Stable, UpdateChannel::Beta] {
        assert_eq!(UpdateChannel::parse(channel.as_str()), Some(channel));
        assert_eq!(
            serde_json::to_value(channel).unwrap(),
            json!(channel.as_str())
        );
    }
    for bad in ["", "Stable", "nightly", "beta "] {
        assert_eq!(UpdateChannel::parse(bad), None, "{bad:?}");
    }
    assert_eq!(UpdateChannel::default(), UpdateChannel::Stable);
}

#[test]
fn endpoints_are_per_channel_and_keep_the_plugin_variables() {
    let tail = "latest.json?target={{target}}&arch={{arch}}&current_version={{current_version}}";
    assert_eq!(
        endpoint(RELEASE_HOST, UpdateChannel::Stable).unwrap(),
        format!("https://releases.ixtable.app/stable/{tail}")
    );
    assert_eq!(
        endpoint("https://staging.example/updates/", UpdateChannel::Beta).unwrap(),
        format!("https://staging.example/updates/beta/{tail}")
    );
}

#[test]
fn endpoints_must_use_https() {
    for base in [
        "http://releases.ixtable.app",
        "",
        "https://",
        "ftp://x",
        "releases.ixtable.app",
        "https://a b",
    ] {
        let err = endpoint(base, UpdateChannel::Stable).unwrap_err();
        assert_eq!(err.code, "INVALID_UPDATE_ENDPOINT", "{base:?}");
    }
}

#[test]
fn stored_preferences_resolve_with_safe_defaults() {
    let s = settings_from(None, None, RELEASE_HOST).unwrap();
    assert_eq!((s.channel, s.auto_check), (UpdateChannel::Stable, true));
    assert_eq!(s.current_version, CURRENT_VERSION);
    assert!(s.endpoint.contains("/stable/"));

    let s = settings_from(Some(&json!("beta")), Some(&json!(false)), RELEASE_HOST).unwrap();
    assert_eq!((s.channel, s.auto_check), (UpdateChannel::Beta, false));
    assert!(s.endpoint.contains("/beta/"));

    // Anything unrecognized (hand-edited state, older formats) falls back to stable + auto-check.
    let s = settings_from(Some(&json!("nightly")), Some(&json!("no")), RELEASE_HOST).unwrap();
    assert_eq!((s.channel, s.auto_check), (UpdateChannel::Stable, true));
    let s = settings_from(Some(&json!(1)), Some(&Value::Null), RELEASE_HOST).unwrap();
    assert_eq!((s.channel, s.auto_check), (UpdateChannel::Stable, true));

    let wire = serde_json::to_value(&s).unwrap();
    assert_eq!(wire["channel"], "stable");
    assert_eq!(wire["autoCheck"], true);
    assert_eq!(wire["currentVersion"], CURRENT_VERSION);
}

#[test]
fn tauri_conf_matches_the_crate_and_the_stable_endpoint() {
    let c = conf();
    // The plugin compares against tauri.conf.json's version; settings report the crate's.
    assert_eq!(c["version"], CURRENT_VERSION);
    let updater = &c["plugins"]["updater"];
    assert_eq!(
        updater["endpoints"],
        json!([endpoint(RELEASE_HOST, UpdateChannel::Stable).unwrap()])
    );
    assert_eq!(c["bundle"]["createUpdaterArtifacts"], true);
    for flag in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
    ] {
        assert!(updater.get(flag).is_none(), "{flag} must stay unset");
    }
}

#[test]
fn the_committed_pubkey_accepts_a_tauri_signed_package() {
    plugin_verify(PAYLOAD, SIGNATURE, &pubkey()).unwrap();
}

#[test]
fn tampered_packages_and_foreign_signatures_are_rejected() {
    let key = pubkey();
    let mut tampered = PAYLOAD.to_vec();
    tampered[0] ^= 1;
    assert!(plugin_verify(&tampered, SIGNATURE, &key).is_err());
    let mut longer = PAYLOAD.to_vec();
    longer.push(b'\n');
    assert!(plugin_verify(&longer, SIGNATURE, &key).is_err());
    assert!(plugin_verify(PAYLOAD, OTHER_KEY_SIGNATURE, &key).is_err());

    // A signature whose trusted comment was edited fails the global signature.
    let text = String::from_utf8(STANDARD.decode(SIGNATURE.trim()).unwrap()).unwrap();
    let forged = STANDARD.encode(text.replace("file:payload.bin", "file:other.bin"));
    assert!(plugin_verify(PAYLOAD, &forged, &key).is_err());

    // Missing or garbage signatures never verify.
    assert!(plugin_verify(PAYLOAD, "", &key).is_err());
    assert!(plugin_verify(PAYLOAD, "not base64!", &key).is_err());
}

#[test]
fn signature_failures_map_to_their_own_error_code() {
    let key =
        PublicKey::decode(&String::from_utf8(STANDARD.decode(pubkey()).unwrap()).unwrap()).unwrap();
    let sig = Signature::decode(
        &String::from_utf8(STANDARD.decode(OTHER_KEY_SIGNATURE.trim()).unwrap()).unwrap(),
    )
    .unwrap();
    let minisign = key.verify(PAYLOAD, &sig, true).unwrap_err();
    use tauri_plugin_updater::Error as E;
    assert_eq!(
        error_code(&E::Minisign(minisign)),
        "UPDATE_SIGNATURE_INVALID"
    );
    assert_eq!(
        error_code(&E::SignatureUtf8("x".into())),
        "UPDATE_SIGNATURE_INVALID"
    );
    assert_eq!(
        error_code(&E::MissingSignedVersion),
        "UPDATE_SIGNATURE_INVALID"
    );
    assert_eq!(
        error_code(&E::InsecureTransportProtocol),
        "INVALID_UPDATE_ENDPOINT"
    );
    assert_eq!(error_code(&E::ReleaseNotFound), "UPDATE_FAILED");
}

#[test]
fn progress_starts_idle() {
    assert_eq!(
        serde_json::to_value(UpdateProgress::default()).unwrap(),
        json!({"phase": "idle", "downloaded": 0, "total": null})
    );
    assert_eq!(
        update_progress("main".into()).unwrap().phase,
        UpdatePhase::Idle
    );
}
