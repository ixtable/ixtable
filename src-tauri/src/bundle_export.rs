//! `export_runtime_bundle`: packages the open Studio document as a signed `.ixtr`.
use crate::archive::{self, ArchiveDocument, ArchiveMetadata, Severity};
use crate::bundle::{
    archive_bytes, build_bundle, fingerprint, io_err, parse_version, sha256_hex, signing_key,
    state_dir, verify, write_atomic, BundleMeta, APP_VERSION,
};
use crate::manager::AppError;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    pub path: String,
    pub bundle_id: String,
    pub name: String,
    pub version: String,
    pub min_runtime_version: Option<String>,
    pub created_at: String,
    pub size: u64,
    pub sha256: String,
    pub signer_fingerprint: String,
    pub encrypted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub version: String,
    #[serde(default)]
    pub release_notes: String,
    #[serde(default)]
    pub min_runtime_version: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Exports the open document as a signed runtime-only bundle (`.ixtr`).
///
/// The release fields are written to `DocumentConfig.release`, the document is saved
/// when it has a location, and validation errors block the export.
#[tauri::command]
pub fn export_runtime_bundle(
    window_label: String,
    path: String,
    options: crate::bundle_export::ExportOptions,
) -> Result<BundleInfo, AppError> {
    let version = parse_version("Version", &options.version)?.to_string();
    let min_runtime_version = match options.min_runtime_version.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => Some(parse_version("Minimum Runtime version", v)?.to_string()),
        _ => None,
    };
    let m = crate::manager()?;
    let state = m.state(&window_label)?;
    if state.runtime_only {
        return Err(AppError::new(
            "READ_ONLY",
            "Runtime bundles cannot be re-exported",
        ));
    }
    let mut config = m.config(&window_label)?;
    let release = archive::ReleaseInfo {
        version: version.clone(),
        notes: options.release_notes.clone(),
        min_runtime_version: min_runtime_version.clone(),
    };
    if config.release != release {
        config.release = release;
        m.update_config(&window_label, config.clone())?;
    }
    let errors: Vec<String> = archive::validate_config(&config)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| format!("{} {}: {}", i.object_kind, i.object_id, i.message))
        .collect();
    if !errors.is_empty() {
        return Err(AppError::new(
            "VALIDATION_FAILED",
            format!("Fix these problems before exporting: {}", errors.join("; ")),
        ));
    }
    if state.path.is_some() {
        m.save(&window_label, None)?;
    }
    let doc = ArchiveDocument {
        metadata: ArchiveMetadata {
            document_id: state.document_id.clone(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            application_version: APP_VERSION.into(),
        },
        data: fs::read(m.database_path(&window_label)?).map_err(io_err)?,
        config: config.clone(),
        attachments: m.attachments(&window_label)?,
    };
    let state_root = state_dir();
    let archive = archive_bytes(&doc, &state_root.join("tmp"))?;
    let key = signing_key(&state_root)?;
    let meta = BundleMeta {
        bundle_id: state.document_id,
        name: config.name.clone(),
        version,
        release_notes: options.release_notes,
        min_runtime_version,
    };
    let bytes = build_bundle(&archive, &meta, options.password.as_deref(), &key)?;
    let destination = PathBuf::from(&path);
    write_atomic(&destination, &bytes)?;
    let signed = verify(&bytes)?;
    Ok(BundleInfo {
        path,
        bundle_id: meta.bundle_id,
        name: meta.name,
        version: meta.version,
        min_runtime_version: meta.min_runtime_version,
        created_at: signed.header.created_at.clone(),
        size: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        signer_fingerprint: signed.signer_fingerprint(),
        encrypted: signed.header.flags.encrypted,
    })
}

/// Public signing-key fingerprint for display (generates the key if missing).
#[tauri::command]
pub fn bundle_signer_fingerprint() -> Result<String, AppError> {
    let key = signing_key(&state_dir())?;
    Ok(fingerprint(&B64.encode(key.verifying_key().as_bytes())))
}
