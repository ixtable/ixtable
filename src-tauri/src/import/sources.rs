//! Bundled read-only file sources (PRD §10). A source is an application asset
//! (so it travels inside the `.ixt` archive and runtime bundles) that the
//! reader exposes as the view `files.<name>` for queries, reports, and
//! dashboards. Nothing writes to it.
use crate::archive::{check_named_ids, DocumentConfig, Issue};
use crate::data::files::{CsvOptions, FileFormat, FileView};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub id: String,
    /// View name: queries read `files.<name>`.
    pub name: String,
    pub asset_id: String,
    pub format: FileFormat,
    #[serde(default)]
    pub csv: CsvOptions,
}

/// A name DuckDB and SQL authors can write unquoted.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 63
}

/// The reader views for a document's file sources (XLSX is import-only).
pub fn views(workspace: &Path, sources: &[FileSource]) -> Vec<FileView> {
    sources
        .iter()
        .filter(|s| s.format != FileFormat::Xlsx && valid_name(&s.name))
        .filter(|s| crate::paths::is_safe_id(&s.asset_id))
        .map(|s| FileView {
            name: s.name.clone(),
            path: crate::archive_io::asset_content(workspace, &s.asset_id),
            format: s.format,
            csv: s.csv.clone(),
        })
        .collect()
}

/// Writes the files of a document's sources into `dir` (a runtime
/// installation, which keeps no extracted assets) so its reader can open them.
pub fn materialize(dir: &Path, doc: &crate::archive::ArchiveDocument) {
    for source in &doc.config.file_sources {
        let Some(asset) = doc.attachments.iter().find(|a| a.id == source.asset_id) else {
            continue;
        };
        if !crate::paths::is_safe_id(&asset.id) {
            continue;
        }
        let written = std::fs::create_dir_all(crate::archive_io::asset_dir(dir, &asset.id))
            .and_then(|()| {
                std::fs::write(
                    crate::archive_io::asset_content(dir, &asset.id),
                    &asset.contents,
                )
            });
        if let Err(e) = written {
            crate::logging::warn("import", &format!("file source {}: {e}", source.name));
        }
    }
}

pub fn validate(config: &DocumentConfig) -> Vec<Issue> {
    let sources = &config.file_sources;
    let mut issues = check_named_ids(
        "fileSource",
        sources.iter().map(|s| (s.id.as_str(), s.name.as_str())),
    );
    let mut names = std::collections::HashSet::new();
    for s in sources {
        let error = |m: String| Issue::error("fileSource", &s.id, m);
        if !valid_name(&s.name) {
            issues.push(error(format!(
                "File source name {:?} must start with a letter and use only letters, digits, and _",
                s.name
            )));
        } else if !names.insert(s.name.to_ascii_lowercase()) {
            issues.push(error(format!("Duplicate file source name {}", s.name)));
        }
        if s.format == FileFormat::Xlsx {
            issues.push(error(format!(
                "{}: XLSX files can be imported into a table but not used as a file source",
                s.name
            )));
        }
        if !crate::paths::is_safe_id(&s.asset_id) {
            issues.push(error(format!("{} does not refer to an asset", s.name)));
        }
    }
    issues
}
