//! Personalized bundle manifests (PRD §21.2).
//!
//! `bundle-manifest` returns `{manifest, signature, archiveUrl}`. The signature
//! is Ed25519 over the manifest's canonical JSON: object keys sorted by code
//! point at every level, no insignificant whitespace, strings and numbers as
//! `JSON.stringify` writes them. A manifest delivered as a string is also
//! accepted when the signature covers exactly those bytes.
//!
//! Nothing in a manifest is trusted before [`verify`] succeeds, and every
//! failure is closed: a bad signature, a wrong format, an expired or
//! future-dated manifest, or one issued for another app, user, or
//! installation is rejected before any archive byte is used.
use super::{b64_any, err};
use crate::manager::AppError;
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FORMAT: &str = "ixtable-cloud-bundle/1";
/// Clock skew tolerated on `issuedAt`.
const MAX_SKEW_SECONDS: i64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub app_id: String,
    pub app_name: String,
    pub version_id: String,
    pub version: String,
    pub archive_sha256: String,
    pub archive_size: u64,
    #[serde(default)]
    pub min_runtime_version: Option<String>,
    pub user_id: String,
    /// Desktop role id assigned to the user (None: no role; nothing is
    /// allowed unless `owner`).
    #[serde(default)]
    pub role_id: Option<String>,
    /// The role's permissions (desktop `roles.rs` shape) at issue time.
    #[serde(default)]
    pub role_permissions: Value,
    #[serde(default)]
    pub role_name: Option<String>,
    /// The user is the app's Developer/Owner: developer access, no role.
    /// Older manifests lack it (false: fail closed).
    #[serde(default)]
    pub owner: bool,
    pub installation_id: String,
    pub fingerprint: String,
    pub issued_at: String,
    pub expires_at: String,
}

/// Canonical JSON text of a value (see module docs).
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // JSON.stringify-compatible ordering for the signer: UTF-16 code units.
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(&map[k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

/// What the caller expects the manifest to be about.
#[derive(Debug, Clone)]
pub struct Expect<'a> {
    pub app_id: &'a str,
    pub user_id: &'a str,
    pub installation_id: &'a str,
}

fn sig_err(message: &str) -> AppError {
    err("MANIFEST_SIGNATURE", message)
}

/// Verifies signature, format, timing, and identity; returns the manifest.
pub fn verify(
    manifest: &Value,
    signature: &str,
    key: &VerifyingKey,
    now: DateTime<Utc>,
    expect: &Expect<'_>,
) -> Result<Manifest, AppError> {
    let sig_bytes =
        b64_any(signature).map_err(|_| sig_err("The bundle signature is not readable"))?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|_| sig_err("The bundle signature is malformed"))?;
    let (value, mut candidates): (Value, Vec<Vec<u8>>) = match manifest {
        Value::String(text) => {
            let parsed: Value = serde_json::from_str(text)
                .map_err(|_| sig_err("The bundle manifest is unreadable"))?;
            let canonical = canonical_json(&parsed).into_bytes();
            (parsed, vec![text.as_bytes().to_vec(), canonical])
        }
        Value::Object(_) => (
            manifest.clone(),
            vec![canonical_json(manifest).into_bytes()],
        ),
        _ => return Err(sig_err("The bundle manifest is missing")),
    };
    let ok = candidates
        .drain(..)
        .any(|bytes| key.verify_strict(&bytes, &sig).is_ok());
    if !ok {
        return Err(sig_err(
            "The bundle manifest signature does not verify with the ixtable Cloud key; it was not used",
        ));
    }
    let m: Manifest = serde_json::from_value(value).map_err(|e| {
        err(
            "MANIFEST_INVALID",
            format!("The bundle manifest is incomplete: {e}"),
        )
    })?;
    if m.format != FORMAT {
        return Err(err(
            "MANIFEST_INVALID",
            format!("Unsupported bundle manifest format {}", m.format),
        ));
    }
    let time = |field: &str, v: &str| {
        DateTime::parse_from_rfc3339(v)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|_| {
                err(
                    "MANIFEST_INVALID",
                    format!("Invalid {field} in the bundle manifest"),
                )
            })
    };
    let issued = time("issuedAt", &m.issued_at)?;
    let expires = time("expiresAt", &m.expires_at)?;
    if issued > now + Duration::seconds(MAX_SKEW_SECONDS) {
        return Err(err(
            "MANIFEST_INVALID",
            "The bundle manifest is dated in the future; check this computer's clock",
        ));
    }
    if expires <= now {
        return Err(err(
            "MANIFEST_EXPIRED",
            "The bundle manifest has expired; sync again to get a fresh one",
        ));
    }
    if m.app_id != expect.app_id
        || m.user_id != expect.user_id
        || m.installation_id != expect.installation_id
    {
        return Err(err(
            "MANIFEST_MISMATCH",
            "The bundle manifest was issued for another application, user, or installation",
        ));
    }
    if !is_sha256_hex(&m.archive_sha256) {
        return Err(err(
            "MANIFEST_INVALID",
            "The bundle manifest has an invalid archive checksum",
        ));
    }
    if m.archive_size > super::MAX_DOWNLOAD_BYTES {
        return Err(err(
            "TOO_LARGE",
            "The published archive is larger than the Runtime accepts",
        ));
    }
    crate::bundle::parse_version("Published version", &m.version)?;
    Ok(m)
}

pub fn is_sha256_hex(v: &str) -> bool {
    v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit())
}

/// Checks downloaded bytes against the verified manifest (fail closed).
pub fn check_archive(m: &Manifest, sha256: &str, size: u64) -> Result<(), AppError> {
    if !sha256.eq_ignore_ascii_case(&m.archive_sha256) || size != m.archive_size {
        return Err(err(
            "ARCHIVE_CHECKSUM",
            "The downloaded archive does not match the signed manifest; it was discarded",
        ));
    }
    Ok(())
}
