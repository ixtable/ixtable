//! Runtime-only bundles (`.ixtr`, PRD §4.1, §21.2).
//!
//! A bundle is a signed envelope around a complete `.ixt` archive (definition plus the
//! bootstrap `data.db` that seeds an installation on first open):
//!
//! ```text
//! MAGIC "IXTRBNDL" | u16 format | u32 header_len | header JSON | u64 payload_len | payload | Ed25519 signature (64)
//! ```
//!
//! All integers are little-endian. The signature covers every byte before it. The payload
//! is the archive bytes, or, for password-protected bundles, Argon2id-derived-key
//! XChaCha20-Poly1305 ciphertext with the header bytes as associated data.
//!
//! The signing key is a per-developer Ed25519 key generated on first export and kept in
//! the local state directory (`keys/runtime-bundle-signing.key`, mode 0600). It is a
//! local key, not a cloud identity: the Runtime pins the first signer it sees for a
//! bundle id (trust on first use) and rejects later bundles signed by anyone else.
use crate::archive::{self, ArchiveDocument};
use crate::manager::AppError;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAGIC: &[u8; 8] = b"IXTRBNDL";
pub const BUNDLE_FORMAT_VERSION: u16 = 1;
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_HEADER_BYTES: usize = 1 << 20;
const SIGNATURE_BYTES: usize = 64;
const KEY_FILE: &str = "runtime-bundle-signing.key";
// OWASP-recommended Argon2id baseline (19 MiB, 2 passes, 1 lane).
const KDF_MEMORY_KIB: u32 = 19 * 1024;
const KDF_ITERATIONS: u32 = 2;
const KDF_PARALLELISM: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleFlags {
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionParams {
    pub kdf: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
    pub cipher: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundleHeader {
    /// Equals the document id of the exported archive.
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub release_notes: String,
    pub app_version: String,
    #[serde(default)]
    pub min_runtime_version: Option<String>,
    pub created_at: String,
    /// Base64 Ed25519 public key of the signer.
    pub signer_public_key: String,
    pub flags: BundleFlags,
    /// SHA-256 of the plaintext archive bytes.
    pub payload_sha256: String,
    pub payload_size: u64,
    #[serde(default)]
    pub encryption: Option<EncryptionParams>,
}

/// Release metadata supplied by the exporter.
#[derive(Debug, Clone, Default)]
pub struct BundleMeta {
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    pub release_notes: String,
    pub min_runtime_version: Option<String>,
}

/// A bundle whose signature has been verified; the payload may still be encrypted.
#[derive(Debug)]
pub struct SignedBundle {
    pub header: BundleHeader,
    payload: Vec<u8>,
    header_bytes: Vec<u8>,
}

fn sig_err(message: impl ToString) -> AppError {
    AppError::new("BUNDLE_SIGNATURE", message)
}
pub(crate) fn io_err(e: impl ToString) -> AppError {
    AppError::new("IO_ERROR", e)
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Short, human-comparable fingerprint of a base64 public key: first 16 bytes of its SHA-256.
pub fn fingerprint(public_key_b64: &str) -> String {
    let digest = Sha256::digest(B64.decode(public_key_b64).unwrap_or_default());
    digest[..16]
        .chunks(2)
        .map(|c| format!("{:02X}{:02X}", c[0], c[1]))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_version(field: &str, value: &str) -> Result<semver::Version, AppError> {
    semver::Version::parse(value.trim()).map_err(|_| {
        AppError::new(
            "INVALID_VERSION",
            format!("{field} \"{value}\" is not a semantic version like 1.2.0"),
        )
    })
}

/// Fails with `BUNDLE_INCOMPATIBLE` when this Runtime is older than the bundle requires.
pub fn check_runtime_compat(header: &BundleHeader, app_version: &str) -> Result<(), AppError> {
    let Some(min) = header
        .min_runtime_version
        .as_deref()
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    let min = semver::Version::parse(min).map_err(|_| {
        AppError::new(
            "BUNDLE_INCOMPATIBLE",
            format!("Invalid minimum Runtime version {min}"),
        )
    })?;
    let current = semver::Version::parse(app_version).map_err(io_err)?;
    if current < min {
        return Err(AppError::new(
            "BUNDLE_INCOMPATIBLE",
            format!("This bundle needs ixtable Runtime {min} or newer; this is {current}."),
        ));
    }
    Ok(())
}

/// Local state directory shared with the document manager (`<IXTABLE_STATE_DIR>/data`).
pub fn state_dir() -> PathBuf {
    std::env::var_os("IXTABLE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("ixtable"))
        .join("data")
}

/// Loads the local developer signing key, generating it (0600) on first use.
pub fn signing_key(state: &Path) -> Result<SigningKey, AppError> {
    let dir = state.join("keys");
    let path = dir.join(KEY_FILE);
    if let Ok(bytes) = fs::read(&path) {
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| AppError::new("SIGNING_KEY", format!("{} is corrupt", path.display())))?;
        return Ok(SigningKey::from_bytes(&seed));
    }
    fs::create_dir_all(&dir).map_err(io_err)?;
    let key = SigningKey::generate(&mut OsRng);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(&key.to_bytes()).map_err(io_err)?;
            file.sync_all().map_err(io_err)?;
            Ok(key)
        }
        // Another export created it first; use that one.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => signing_key(state),
        Err(e) => Err(io_err(e)),
    }
}

fn derive_key(password: &str, params: &EncryptionParams) -> Result<[u8; 32], AppError> {
    if params.kdf != "argon2id" || params.cipher != "xchacha20poly1305" {
        return Err(sig_err("Unsupported bundle encryption"));
    }
    if params.memory_kib > 1 << 20 || params.iterations > 16 || params.parallelism > 16 {
        return Err(sig_err("Bundle key-derivation parameters are out of range"));
    }
    let salt = B64.decode(&params.salt).map_err(sig_err)?;
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(
            params.memory_kib,
            params.iterations,
            params.parallelism,
            Some(32),
        )
        .map_err(sig_err)?,
    );
    let mut key = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(sig_err)?;
    Ok(key)
}

fn encode_header(header: &BundleHeader) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec(header).map_err(io_err)
}

/// Builds a signed (and optionally password-encrypted) bundle around archive bytes.
pub fn build_bundle(
    archive: &[u8],
    meta: &BundleMeta,
    password: Option<&str>,
    key: &SigningKey,
) -> Result<Vec<u8>, AppError> {
    let password = password.filter(|p| !p.is_empty());
    let encryption = password.map(|_| {
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        EncryptionParams {
            kdf: "argon2id".into(),
            memory_kib: KDF_MEMORY_KIB,
            iterations: KDF_ITERATIONS,
            parallelism: KDF_PARALLELISM,
            salt: B64.encode(salt),
            cipher: "xchacha20poly1305".into(),
            nonce: B64.encode(nonce),
        }
    });
    let header = BundleHeader {
        bundle_id: meta.bundle_id.clone(),
        name: meta.name.clone(),
        version: meta.version.clone(),
        release_notes: meta.release_notes.clone(),
        app_version: APP_VERSION.into(),
        min_runtime_version: meta.min_runtime_version.clone(),
        created_at: Utc::now().to_rfc3339(),
        signer_public_key: B64.encode(key.verifying_key().as_bytes()),
        flags: BundleFlags {
            encrypted: encryption.is_some(),
        },
        payload_sha256: sha256_hex(archive),
        payload_size: archive.len() as u64,
        encryption,
    };
    let header_bytes = encode_header(&header)?;
    let payload = match (&header.encryption, password) {
        (Some(params), Some(password)) => {
            let derived = derive_key(password, params)?;
            let cipher = XChaCha20Poly1305::new((&derived).into());
            let nonce = B64.decode(&params.nonce).map_err(io_err)?;
            cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: archive,
                        aad: &header_bytes,
                    },
                )
                .map_err(|_| AppError::new("BUNDLE_ENCRYPTION", "Encryption failed"))?
        }
        _ => archive.to_vec(),
    };
    let mut out = Vec::with_capacity(header_bytes.len() + payload.len() + 96);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&BUNDLE_FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&payload);
    let signature = key.sign(&out);
    out.extend_from_slice(&signature.to_bytes());
    Ok(out)
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8], AppError> {
    let end = at
        .checked_add(n)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| sig_err("The bundle is truncated"))?;
    let slice = &bytes[*at..end];
    *at = end;
    Ok(slice)
}

/// Parses the envelope and verifies its signature. Nothing else is trusted before this
/// succeeds; every structural problem fails closed with `BUNDLE_SIGNATURE`.
pub fn verify(bytes: &[u8]) -> Result<SignedBundle, AppError> {
    let mut at = 0;
    if take(bytes, &mut at, MAGIC.len()).map_err(|_| sig_err("Not an ixtable runtime bundle"))?
        != MAGIC
    {
        return Err(sig_err("Not an ixtable runtime bundle"));
    }
    let format = u16::from_le_bytes(take(bytes, &mut at, 2)?.try_into().unwrap());
    if format != BUNDLE_FORMAT_VERSION {
        return Err(sig_err(format!("Unsupported bundle format {format}")));
    }
    let header_len = u32::from_le_bytes(take(bytes, &mut at, 4)?.try_into().unwrap()) as usize;
    if header_len > MAX_HEADER_BYTES {
        return Err(sig_err("Bundle header is too large"));
    }
    let header_bytes = take(bytes, &mut at, header_len)?.to_vec();
    let payload_len = u64::from_le_bytes(take(bytes, &mut at, 8)?.try_into().unwrap());
    let payload = take(
        bytes,
        &mut at,
        usize::try_from(payload_len).map_err(sig_err)?,
    )?
    .to_vec();
    let signed_len = at;
    let signature = take(bytes, &mut at, SIGNATURE_BYTES)?;
    if at != bytes.len() {
        return Err(sig_err("Unexpected bytes after the bundle signature"));
    }
    let header: BundleHeader = serde_json::from_slice(&header_bytes)
        .map_err(|e| sig_err(format!("Unreadable bundle header: {e}")))?;
    let public: [u8; 32] = B64
        .decode(&header.signer_public_key)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| sig_err("Invalid signer key"))?;
    let verifying = VerifyingKey::from_bytes(&public).map_err(|_| sig_err("Invalid signer key"))?;
    let signature = Signature::from_slice(signature).map_err(|_| sig_err("Invalid signature"))?;
    verifying
        .verify_strict(&bytes[..signed_len], &signature)
        .map_err(|_| {
            sig_err("The bundle signature does not match its contents; it may have been modified")
        })?;
    if header.flags.encrypted != header.encryption.is_some() {
        return Err(sig_err("Inconsistent encryption flags"));
    }
    Ok(SignedBundle {
        header,
        payload,
        header_bytes,
    })
}

impl SignedBundle {
    pub fn signer_fingerprint(&self) -> String {
        fingerprint(&self.header.signer_public_key)
    }
    /// Decrypts (when protected) and checks the archive digest.
    pub fn archive_bytes(&self, password: Option<&str>) -> Result<Vec<u8>, AppError> {
        let plain = match &self.header.encryption {
            None => self.payload.clone(),
            Some(params) => {
                let password = password.filter(|p| !p.is_empty()).ok_or_else(|| {
                    AppError::new(
                        "BUNDLE_PASSWORD_REQUIRED",
                        "This bundle is password protected",
                    )
                })?;
                let derived = derive_key(password, params)?;
                let nonce = B64.decode(&params.nonce).map_err(sig_err)?;
                if nonce.len() != 24 {
                    return Err(sig_err("Invalid bundle nonce"));
                }
                XChaCha20Poly1305::new((&derived).into())
                    .decrypt(
                        XNonce::from_slice(&nonce),
                        Payload {
                            msg: &self.payload,
                            aad: &self.header_bytes,
                        },
                    )
                    .map_err(|_| AppError::new("BUNDLE_PASSWORD", "The password is incorrect"))?
            }
        };
        if plain.len() as u64 != self.header.payload_size
            || sha256_hex(&plain) != self.header.payload_sha256
        {
            return Err(sig_err("Bundle payload checksum mismatch"));
        }
        Ok(plain)
    }
}

/// Validates archive bytes by reading them back with the normal archive reader.
pub fn read_archive_bytes(bytes: &[u8], scratch: &Path) -> Result<ArchiveDocument, AppError> {
    fs::create_dir_all(scratch).map_err(io_err)?;
    let tmp = scratch.join(format!(".bundle-{}.ixt", Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(io_err)?;
    let doc = archive::read_archive(&tmp);
    let _ = fs::remove_file(&tmp);
    Ok(doc?)
}

/// Writes `doc` as a validated archive and returns its bytes.
pub fn archive_bytes(doc: &ArchiveDocument, scratch: &Path) -> Result<Vec<u8>, AppError> {
    fs::create_dir_all(scratch).map_err(io_err)?;
    let tmp = scratch.join(format!(".export-{}.ixt", Uuid::new_v4()));
    let result = archive::write_archive(&tmp, doc)
        .map_err(AppError::from)
        .and_then(|_| fs::read(&tmp).map_err(io_err));
    let _ = fs::remove_file(&tmp);
    result
}

/// Atomic file write: temp file in the same directory, fsync, rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(io_err)?;
    let tmp = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&tmp, bytes)?;
        fs::File::open(&tmp)?.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io_err)
}

#[cfg(test)]
mod tests {
    include!("bundle/tests.rs");
}
