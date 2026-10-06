//! Where ixtable Cloud is and which key signs its bundles.
//!
//! Resolution order for each setting: environment variable, then the global
//! preference, then the build default. Debug builds default to the local
//! Supabase CLI stack; release builds take their defaults from build-time
//! environment variables (`IXTABLE_CLOUD_BUILD_URL`, `IXTABLE_CLOUD_BUILD_ANON_KEY`,
//! `IXTABLE_CLOUD_BUILD_SITE_URL`) and are otherwise "not configured".
//!
//! The bundle-signing public key is pinned at build time
//! (`IXTABLE_CLOUD_PUBLIC_KEY_RAW`, the raw 32-byte key in base64, or
//! `IXTABLE_CLOUD_PUBLIC_KEY`, SPKI DER base64, in the build environment). Only debug builds
//! accept a runtime override from the `IXTABLE_CLOUD_PUBLIC_KEY` environment
//! variable, for development and tests against the local stack. A build with
//! no key refuses every cloud install (fail closed).
use super::{b64_any, err};
use crate::manager::AppError;
use ed25519_dalek::VerifyingKey;
use serde::Serialize;

/// Local Supabase CLI API (`supabase start`).
pub const DEV_URL: &str = "http://127.0.0.1:54321";
/// Local website (Docusaurus dev server) that hosts `/desktop-auth`.
pub const DEV_SITE_URL: &str = "http://127.0.0.1:3001";
/// The Supabase CLI's well-known local anon key (HS256 with the CLI's default
/// JWT secret). Public and only accepted by a local stack.
pub const DEV_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/// Bundle-signing public key pinned into this build (base64, hex, PEM, or JWK).
const PINNED_PUBLIC_KEY: Option<&str> = pinned_key(
    option_env!("IXTABLE_CLOUD_PUBLIC_KEY_RAW"),
    option_env!("IXTABLE_CLOUD_PUBLIC_KEY"),
);

const fn is_blank(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_whitespace() {
            return false;
        }
        i += 1;
    }
    true
}

/// The RAW key unless blank, else the SPKI key unless blank. release.yml sets an unset
/// repository variable to `""`, which must fall back like scripts/release/keys.mjs does.
const fn pinned_key(raw: Option<&'static str>, spki: Option<&'static str>) -> Option<&'static str> {
    match (raw, spki) {
        (Some(k), _) if !is_blank(k) => Some(k),
        (_, Some(k)) if !is_blank(k) => Some(k),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    /// Supabase API base URL, without a trailing slash.
    pub url: String,
    pub anon_key: String,
    /// Website base URL (desktop sign-in hand-off page).
    pub site_url: String,
    /// True when both URL and anon key are known.
    pub configured: bool,
    /// Fingerprint of the bundle-signing key, or None when no key is pinned.
    pub public_key_fingerprint: Option<String>,
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Pure resolution over injected sources (unit-tested).
pub fn resolve_with(
    env: impl Fn(&str) -> Option<String>,
    pref: impl Fn(&str) -> Option<String>,
    debug: bool,
) -> CloudConfig {
    let pick = |env_key: &str, pref_key: &str, dev: &str, build: Option<&str>| {
        non_empty(env(env_key))
            .or_else(|| non_empty(pref(pref_key)))
            .unwrap_or_else(|| {
                if debug {
                    dev.to_string()
                } else {
                    build.unwrap_or("").to_string()
                }
            })
    };
    let url = pick(
        "IXTABLE_CLOUD_URL",
        "cloud.url",
        DEV_URL,
        option_env!("IXTABLE_CLOUD_BUILD_URL"),
    )
    .trim_end_matches('/')
    .to_string();
    let anon_key = pick(
        "IXTABLE_CLOUD_ANON_KEY",
        "cloud.anonKey",
        DEV_ANON_KEY,
        option_env!("IXTABLE_CLOUD_BUILD_ANON_KEY"),
    );
    let site_url = pick(
        "IXTABLE_CLOUD_SITE_URL",
        "cloud.siteUrl",
        DEV_SITE_URL,
        option_env!("IXTABLE_CLOUD_BUILD_SITE_URL"),
    )
    .trim_end_matches('/')
    .to_string();
    let key = public_key_with(&env, debug).ok();
    CloudConfig {
        configured: !url.is_empty() && !anon_key.is_empty(),
        public_key_fingerprint: key.map(|k| crate::bundle::fingerprint(&base64_key(&k))),
        url,
        anon_key,
        site_url,
    }
}

fn preference(key: &str) -> Option<String> {
    let value = crate::manager().ok()?.global.preference(key).ok()??;
    value.as_str().map(str::to_string)
}

/// The effective cloud configuration of this process.
pub fn current() -> CloudConfig {
    resolve_with(
        |k| std::env::var(k).ok(),
        preference,
        cfg!(debug_assertions),
    )
}

/// Like [`current`], failing with CLOUD_NOT_CONFIGURED when unusable.
pub fn required() -> Result<CloudConfig, AppError> {
    let cfg = current();
    if !cfg.configured {
        return Err(err(
            "CLOUD_NOT_CONFIGURED",
            "ixtable Cloud is not configured in this build (set IXTABLE_CLOUD_URL and IXTABLE_CLOUD_ANON_KEY)",
        ));
    }
    Ok(cfg)
}

pub fn base64_key(key: &VerifyingKey) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(key.as_bytes())
}

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410).
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Parses an Ed25519 public key given as raw base64/base64url, hex, SPKI
/// (DER base64 or PEM), or a JWK (`{"kty":"OKP","crv":"Ed25519","x":…}`).
pub fn parse_public_key(text: &str) -> Result<VerifyingKey, AppError> {
    let bad = || {
        err(
            "CLOUD_KEY_INVALID",
            "The ixtable Cloud public key is not a valid Ed25519 key",
        )
    };
    let t = text.trim().trim_matches('"');
    let bytes: Vec<u8> = if t.starts_with('{') {
        let jwk: serde_json::Value = serde_json::from_str(t).map_err(|_| bad())?;
        if jwk["kty"] != "OKP" || jwk["crv"] != "Ed25519" {
            return Err(bad());
        }
        b64_any(jwk["x"].as_str().ok_or_else(bad)?)?
    } else if t.starts_with("-----BEGIN") {
        let body: String = t
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        b64_any(&body)?
    } else if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        (0..32)
            .map(|i| u8::from_str_radix(&t[i * 2..i * 2 + 2], 16).map_err(|_| bad()))
            .collect::<Result<_, _>>()?
    } else {
        b64_any(t)?
    };
    let raw: [u8; 32] = if bytes.len() == 44 && bytes[..12] == SPKI_PREFIX {
        bytes[12..].try_into().map_err(|_| bad())?
    } else {
        bytes.as_slice().try_into().map_err(|_| bad())?
    };
    VerifyingKey::from_bytes(&raw).map_err(|_| bad())
}

fn public_key_with(
    env: &impl Fn(&str) -> Option<String>,
    debug: bool,
) -> Result<VerifyingKey, AppError> {
    let runtime = if debug {
        non_empty(env("IXTABLE_CLOUD_PUBLIC_KEY_RAW"))
            .or_else(|| non_empty(env("IXTABLE_CLOUD_PUBLIC_KEY")))
    } else {
        None
    };
    match runtime
        .as_deref()
        .or(PINNED_PUBLIC_KEY.filter(|k| !k.trim().is_empty()))
    {
        Some(text) => parse_public_key(text),
        None => Err(err(
            "CLOUD_KEY_MISSING",
            "This build has no ixtable Cloud signing key, so cloud bundles cannot be verified",
        )),
    }
}

/// The pinned bundle-signing key (see module docs).
pub fn public_key() -> Result<VerifyingKey, AppError> {
    public_key_with(&|k| std::env::var(k).ok(), cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::pinned_key;

    #[test]
    fn blank_raw_key_falls_back_to_spki() {
        assert_eq!(pinned_key(Some("raw"), Some("spki")), Some("raw"));
        assert_eq!(pinned_key(Some(""), Some("spki")), Some("spki"));
        assert_eq!(pinned_key(Some(" \n"), Some("spki")), Some("spki"));
        assert_eq!(pinned_key(None, Some("spki")), Some("spki"));
        assert_eq!(pinned_key(Some(""), Some("")), None);
        assert_eq!(pinned_key(None, None), None);
    }
}
