//! Release key checks for `build.rs` (docs/decisions/desktop-updates.md). A build with
//! `IXTABLE_RELEASE=1` fails unless it pins a release cloud key and overrides the committed
//! development updater key. Shared with the lib only for its unit tests, so it uses no crate
//! paths. Mirrors `releaseKeyProblems` in scripts/release/keys.mjs.
use base64::alphabet;
use base64::engine::general_purpose::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;

/// Standard base64 with or without padding, as Node's decoder accepts.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The cloud key text the build pins: the RAW variable unless blank, else the SPKI one.
pub fn pinned_cloud_key<'a>(raw: Option<&'a str>, spki: Option<&'a str>) -> Option<&'a str> {
    let present = |k: &&str| !k.trim().is_empty();
    raw.filter(present).or(spki.filter(present))
}

/// Raw 32-byte Ed25519 key from hex, PEM, or base64/base64url of the raw key or SPKI DER.
pub fn raw_cloud_key(text: &str) -> Option<[u8; 32]> {
    let t = text.trim().trim_matches('"');
    let bytes = if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..32)
            .map(|i| u8::from_str_radix(&t[i * 2..i * 2 + 2], 16).ok())
            .collect::<Option<Vec<u8>>>()?
    } else {
        let body: String = t
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>()
            .replace('-', "+")
            .replace('_', "/");
        LENIENT.decode(body).ok()?
    };
    let key = match bytes.strip_prefix(&SPKI_PREFIX[..]) {
        Some(rest) => rest,
        None => &bytes[..],
    };
    key.try_into().ok()
}

/// Ed25519 key bytes of a Tauri updater pubkey (base64 of a minisign `.pub` file).
pub fn minisign_key(pubkey: &str) -> Option<Vec<u8>> {
    let text = String::from_utf8(STANDARD.decode(pubkey.trim()).ok()?).ok()?;
    let raw = STANDARD.decode(text.lines().nth(1)?.trim()).ok()?;
    (raw.len() == 42 && raw.starts_with(b"Ed")).then(|| raw[10..].to_vec())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Inputs to the release check, read from the build environment and the repository.
pub struct ReleaseKeys<'a> {
    pub cloud_raw: Option<&'a str>,
    pub cloud_spki: Option<&'a str>,
    /// `scripts/release/dev-cloud-keys.json`.
    pub dev_cloud_keys_json: &'a str,
    /// The committed `plugins.updater.pubkey` in tauri.conf.json.
    pub committed_updater_pubkey: &'a str,
    /// `TAURI_CONFIG`, the JSON merge patch the Tauri CLI passes for `--config`.
    pub tauri_config: Option<&'a str>,
}

/// Problems that make this build unfit for beta/stable. Names variables, never key values.
pub fn release_key_problems(k: &ReleaseKeys) -> Vec<String> {
    let mut problems = Vec::new();
    match pinned_cloud_key(k.cloud_raw, k.cloud_spki) {
        None => problems.push(
            "IXTABLE_CLOUD_PUBLIC_KEY_RAW is not set (a build without it refuses every cloud install)"
                .to_string(),
        ),
        Some(text) => match raw_cloud_key(text) {
            None => problems
                .push("IXTABLE_CLOUD_PUBLIC_KEY_RAW: not a valid Ed25519 public key".to_string()),
            Some(raw) => {
                let dev: serde_json::Value =
                    serde_json::from_str(k.dev_cloud_keys_json).unwrap_or_default();
                let listed = dev["keys"].as_array().map(|keys| {
                    keys.iter()
                        .any(|key| key.as_str() == Some(hex(&raw).as_str()))
                });
                match listed {
                    None => problems.push("dev-cloud-keys.json is malformed".to_string()),
                    Some(true) => problems.push(
                        "IXTABLE_CLOUD_PUBLIC_KEY_RAW is a development or test key".to_string(),
                    ),
                    Some(false) => {}
                }
            }
        },
    }
    let override_key = k
        .tauri_config
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| {
            v["plugins"]["updater"]["pubkey"]
                .as_str()
                .map(str::to_string)
        });
    match override_key {
        None => problems.push(
            "the updater pubkey is the committed development key (no --config override)"
                .to_string(),
        ),
        Some(pubkey) => match minisign_key(&pubkey) {
            None => problems.push("the updater pubkey override is malformed".to_string()),
            Some(key) if Some(&key) == minisign_key(k.committed_updater_pubkey).as_ref() => {
                problems.push("the updater pubkey is the committed development key".to_string())
            }
            Some(_) => {}
        },
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV_KEYS: &str = include_str!("../../scripts/release/dev-cloud-keys.json");
    const RFC8032_B64: &str = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";

    fn tauri_conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    fn committed() -> String {
        tauri_conf()["plugins"]["updater"]["pubkey"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// A minisign pubkey (base64 of the .pub file) for a 32-byte key filled with `byte`.
    fn minisign_pubkey(byte: u8) -> String {
        let mut body = b"Ed".to_vec();
        body.extend([7u8; 8]);
        body.extend([byte; 32]);
        let file = format!("untrusted comment: test\n{}\n", STANDARD.encode(body));
        STANDARD.encode(file)
    }

    fn problems(raw: Option<&str>, spki: Option<&str>, config: Option<&str>) -> Vec<String> {
        let committed = committed();
        release_key_problems(&ReleaseKeys {
            cloud_raw: raw,
            cloud_spki: spki,
            dev_cloud_keys_json: DEV_KEYS,
            committed_updater_pubkey: &committed,
            tauri_config: config,
        })
    }

    fn release_config() -> String {
        serde_json::json!({ "plugins": { "updater": { "pubkey": minisign_pubkey(9) } } })
            .to_string()
    }

    fn release_cloud_key() -> String {
        STANDARD.encode([5u8; 32])
    }

    #[test]
    fn accepts_release_keys_and_falls_back_from_a_blank_raw_key() {
        let cfg = release_config();
        let key = release_cloud_key();
        assert!(problems(Some(&key), None, Some(&cfg)).is_empty());
        let spki = STANDARD.encode([&SPKI_PREFIX[..], &[5u8; 32]].concat());
        assert!(problems(Some(""), Some(&spki), Some(&cfg)).is_empty());
        assert!(problems(Some("  "), Some(&spki), Some(&cfg)).is_empty());
    }

    #[test]
    fn refuses_missing_malformed_and_dev_cloud_keys() {
        let cfg = release_config();
        assert_eq!(
            problems(Some(""), Some(""), Some(&cfg)),
            ["IXTABLE_CLOUD_PUBLIC_KEY_RAW is not set (a build without it refuses every cloud install)"]
        );
        assert_eq!(
            problems(Some("abc"), None, Some(&cfg)),
            ["IXTABLE_CLOUD_PUBLIC_KEY_RAW: not a valid Ed25519 public key"]
        );
        let spki = STANDARD.encode(
            STANDARD
                .decode(RFC8032_B64)
                .map(|k| [&SPKI_PREFIX[..], &k].concat())
                .unwrap(),
        );
        let hex_key = "57b73bbef374efb52c4197e46cc61c783cf1cd01266dbb8abc0a0b1e8bd1728d";
        for dev in [
            RFC8032_B64,
            spki.as_str(),
            hex_key,
            &STANDARD.encode([0u8; 32]),
        ] {
            assert_eq!(
                problems(Some(dev), None, Some(&cfg)),
                ["IXTABLE_CLOUD_PUBLIC_KEY_RAW is a development or test key"],
                "{dev}"
            );
        }
    }

    #[test]
    fn refuses_the_committed_updater_key() {
        let key = release_cloud_key();
        assert_eq!(
            problems(Some(&key), None, None),
            ["the updater pubkey is the committed development key (no --config override)"]
        );
        let dev = serde_json::json!({ "plugins": { "updater": { "pubkey": committed() } } });
        assert_eq!(
            problems(Some(&key), None, Some(&dev.to_string())),
            ["the updater pubkey is the committed development key"]
        );
        let bad = r#"{"plugins":{"updater":{"pubkey":"bm90IGEga2V5"}}}"#;
        assert_eq!(
            problems(Some(&key), None, Some(bad)),
            ["the updater pubkey override is malformed"]
        );
    }

    #[test]
    fn decodes_every_cloud_key_encoding() {
        let raw = [3u8; 32];
        let spki = [&SPKI_PREFIX[..], &raw].concat();
        let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
            STANDARD.encode(&spki)
        );
        let url = STANDARD.encode(raw).replace('+', "-").replace('/', "_");
        for text in [
            STANDARD.encode(raw),
            STANDARD.encode(&spki),
            hex,
            pem,
            url.trim_end_matches('=').to_string(),
        ] {
            assert_eq!(raw_cloud_key(&text), Some(raw), "{text}");
        }
        assert_eq!(raw_cloud_key("abc"), None);
    }
}
