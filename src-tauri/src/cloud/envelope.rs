//! Credential envelopes (PRD §21.3): the datasource secret is encrypted with a
//! fresh random 256-bit data key (DEK) using XChaCha20-Poly1305. Studio sends
//! the ciphertext and the DEK to `credential-envelope`, which wraps the DEK with
//! the cloud KEK; Runtime gets the DEK back only through a key grant. The AAD
//! binds the ciphertext to app, datasource, scope, and user.
use super::{b64_any, err};
use crate::manager::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    pub ciphertext: String,
    pub nonce: String,
    pub aad: String,
    /// Base64 DEK; sent once to the cloud, never stored locally.
    pub dek: String,
}

/// Associated data for an envelope.
pub fn aad_for(app_id: &str, datasource_id: &str, scope: &str, user_id: Option<&str>) -> String {
    format!(
        "ixtable-credential/1|{app_id}|{datasource_id}|{scope}|{}",
        user_id.unwrap_or("")
    )
}

/// Encrypts `plain` under a fresh DEK.
pub fn seal(plain: &[u8], aad: &str) -> Result<Sealed, AppError> {
    let mut dek = [0u8; 32];
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut dek);
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = XChaCha20Poly1305::new((&dek).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| err("ENCRYPTION_FAILED", "The credential could not be encrypted"))?;
    let sealed = Sealed {
        ciphertext: STANDARD.encode(ciphertext),
        nonce: STANDARD.encode(nonce),
        aad: aad.to_string(),
        dek: STANDARD.encode(dek),
    };
    dek.fill(0);
    Ok(sealed)
}

/// Decrypts an envelope with its DEK (memory only).
pub fn open(ciphertext: &str, nonce: &str, aad: &str, dek: &str) -> Result<Vec<u8>, AppError> {
    let bad = || {
        err(
            "CREDENTIAL_DECRYPT",
            "The datasource credential from ixtable Cloud could not be decrypted",
        )
    };
    let mut key = b64_any(dek).map_err(|_| bad())?;
    let nonce = b64_any(nonce).map_err(|_| bad())?;
    let ct = b64_any(ciphertext).map_err(|_| bad())?;
    if key.len() != 32 || nonce.len() != 24 {
        key.fill(0);
        return Err(bad());
    }
    let cipher = XChaCha20Poly1305::new(key.as_slice().into());
    key.fill(0);
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| bad())
}

/// Plaintext of a datasource credential envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub v: u32,
    pub kind: String,
    pub password: String,
    /// `secrets::datasource_target` of the datasource it was sealed for.
    pub target: String,
}
