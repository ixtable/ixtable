//! Password-protected runtime bundles, Ed25519 signatures, and envelope encryption.
use argon2::{Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

const ARGON2_M_KIB: u32 = 32 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignedBundle {
    pub app_id: String,
    pub user_id: String,
    pub archive_sha256: String,
    pub signature: String,
    pub verifying_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordBundle {
    pub kdf: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEnvelope {
    pub kek_nonce: String,
    pub wrapped_dek: String,
    pub dek_nonce: String,
    pub ciphertext: String,
}

fn argon_key(password: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(32)).map_err(|e| e.to_string())?;
    let argon = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(password, salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn encrypt(key: &[u8; 32], nonce: &[u8; 24], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| e.to_string())
}

fn decrypt(key: &[u8; 32], nonce: &[u8; 24], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|e| e.to_string())
}

pub fn wrap_password_bundle(password: &str, archive: &[u8]) -> Result<PasswordBundle, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut key = argon_key(password.as_bytes(), &salt)?;
    let ciphertext = encrypt(&key, &nonce, b"ixtable.runtime-bundle.v1", archive)?;
    key.zeroize();
    Ok(PasswordBundle {
        kdf: "argon2id".into(),
        salt: hex::encode(salt),
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
    })
}

pub fn unwrap_password_bundle(password: &str, bundle: &PasswordBundle) -> Result<Vec<u8>, String> {
    if bundle.kdf != "argon2id" {
        return Err("unsupported kdf".into());
    }
    let salt = hex::decode(&bundle.salt).map_err(|e| e.to_string())?;
    let nonce = hex::decode(&bundle.nonce).map_err(|e| e.to_string())?;
    let ciphertext = hex::decode(&bundle.ciphertext).map_err(|e| e.to_string())?;
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| "nonce must be 24 bytes".to_string())?;
    let mut key = argon_key(password.as_bytes(), &salt)?;
    let plain = decrypt(&key, &nonce, b"ixtable.runtime-bundle.v1", &ciphertext);
    key.zeroize();
    plain
}

fn signed_message(app_id: &str, user_id: &str, archive_sha256: &str) -> Vec<u8> {
    format!("ixtable.bundle.v1|{app_id}|{user_id}|{archive_sha256}").into_bytes()
}

pub fn archive_sha256(archive: &[u8]) -> String {
    format!("{:x}", Sha256::digest(archive))
}

pub fn sign_personalized_bundle(
    signing_key: &SigningKey,
    app_id: &str,
    user_id: &str,
    archive: &[u8],
) -> SignedBundle {
    let digest = archive_sha256(archive);
    let sig = signing_key.sign(&signed_message(app_id, user_id, &digest));
    SignedBundle {
        app_id: app_id.into(),
        user_id: user_id.into(),
        archive_sha256: digest,
        signature: hex::encode(sig.to_bytes()),
        verifying_key: hex::encode(signing_key.verifying_key().to_bytes()),
    }
}

pub fn verify_personalized_bundle(bundle: &SignedBundle, archive: &[u8]) -> Result<(), String> {
    if archive_sha256(archive) != bundle.archive_sha256 {
        return Err("archive checksum mismatch".into());
    }
    let key_bytes = hex::decode(&bundle.verifying_key).map_err(|e| e.to_string())?;
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "verifying key must be 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| e.to_string())?;
    let sig_bytes = hex::decode(&bundle.signature).map_err(|e| e.to_string())?;
    let sig_bytes: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_bytes);
    key.verify(
        &signed_message(&bundle.app_id, &bundle.user_id, &bundle.archive_sha256),
        &signature,
    )
    .map_err(|_| "signature verification failed".to_string())
}

pub fn wrap_credentials(kek: &[u8; 32], plaintext: &[u8]) -> Result<CredentialEnvelope, String> {
    let mut dek = [0u8; 32];
    let mut kek_nonce = [0u8; 24];
    let mut dek_nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut dek);
    rand::thread_rng().fill_bytes(&mut kek_nonce);
    rand::thread_rng().fill_bytes(&mut dek_nonce);
    let hk = Hkdf::<Sha256>::new(None, kek);
    let mut derived = [0u8; 32];
    hk.expand(b"ixtable.envelope.kek.v1", &mut derived)
        .map_err(|e| e.to_string())?;
    let wrapped_dek = encrypt(&derived, &kek_nonce, b"ixtable.dek.v1", &dek)?;
    let ciphertext = encrypt(&dek, &dek_nonce, b"ixtable.credential.v1", plaintext)?;
    dek.zeroize();
    Ok(CredentialEnvelope {
        kek_nonce: hex::encode(kek_nonce),
        wrapped_dek: hex::encode(wrapped_dek),
        dek_nonce: hex::encode(dek_nonce),
        ciphertext: hex::encode(ciphertext),
    })
}

pub fn unwrap_credentials(kek: &[u8; 32], envelope: &CredentialEnvelope) -> Result<Vec<u8>, String> {
    let hk = Hkdf::<Sha256>::new(None, kek);
    let mut derived = [0u8; 32];
    hk.expand(b"ixtable.envelope.kek.v1", &mut derived)
        .map_err(|e| e.to_string())?;
    let kek_nonce: [u8; 24] = hex::decode(&envelope.kek_nonce)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "kek nonce must be 24 bytes".to_string())?;
    let wrapped = hex::decode(&envelope.wrapped_dek).map_err(|e| e.to_string())?;
    let mut dek_vec = decrypt(&derived, &kek_nonce, b"ixtable.dek.v1", &wrapped)?;
    let dek: [u8; 32] = dek_vec
        .as_slice()
        .try_into()
        .map_err(|_| "dek must be 32 bytes".to_string())?;
    dek_vec.zeroize();
    let dek_nonce: [u8; 24] = hex::decode(&envelope.dek_nonce)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "dek nonce must be 24 bytes".to_string())?;
    let ciphertext = hex::decode(&envelope.ciphertext).map_err(|e| e.to_string())?;
    decrypt(&dek, &dek_nonce, b"ixtable.credential.v1", &ciphertext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    #[test]
    fn password_bundle_round_trips_and_rejects_wrong_password() {
        let archive = b"ixt-archive-bytes";
        let bundle = wrap_password_bundle("correct horse", archive).unwrap();
        assert_eq!(unwrap_password_bundle("correct horse", &bundle).unwrap(), archive);
        assert!(unwrap_password_bundle("wrong", &bundle).is_err());
    }

    #[test]
    fn personalized_signature_binds_user_and_archive() {
        let mut rng = OsRng;
        let key = SigningKey::generate(&mut rng);
        let archive = b"checkpoint-bytes";
        let bundle = sign_personalized_bundle(&key, "app-1", "user-9", archive);
        verify_personalized_bundle(&bundle, archive).unwrap();
        assert!(verify_personalized_bundle(&bundle, b"tampered").is_err());
        let mut other = bundle.clone();
        other.user_id = "user-8".into();
        assert!(verify_personalized_bundle(&other, archive).is_err());
    }

    #[test]
    fn envelope_requires_the_kek() {
        let kek = [7u8; 32];
        let envelope = wrap_credentials(&kek, br#"{"host":"db.example"}"#).unwrap();
        let opened = unwrap_credentials(&kek, &envelope).unwrap();
        assert_eq!(opened, br#"{"host":"db.example"}"#);
        assert!(unwrap_credentials(&[8u8; 32], &envelope).is_err());
    }
}
