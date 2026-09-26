# PRD: Application Assets

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define storage, lifecycle, integrity, safety, backup, and update behavior for application-definition assets.

Record-linked/business-record attachments are explicitly deferred from the commercial MVP and require a separate future PRD before implementation.

## Application assets

Examples:

- logos;
- form/report images;
- bundled reference files used by the application definition.

Application assets are part of the editable `.ixt` application checkpoint.

Current archive storage records:

- stable asset ID;
- display filename;
- declared/detected media type;
- checksum;
- uncompressed size;
- created/updated timestamps;
- compression metadata;
- content bytes.

Working-session extraction uses stable-ID directories rather than user filenames as paths.

Application assets are versioned with application definitions.

## Identity and references

- Stable asset ID is storage identity.
- Display filename is mutable metadata.
- User-supplied path/filename never determines extraction path.
- Definition objects reference application assets by stable ID.
- Renaming an asset never rewrites dependent references solely because the label changed.

## Import

Import must:

1. enforce configured size limits;
2. read bytes safely;
3. derive/validate media handling policy;
4. calculate checksum;
5. allocate stable ID;
6. store metadata + bytes atomically from the application's perspective.

Application-asset import marks the application definition dirty and participates in normal archive autosave.

## Integrity

- Checksum and uncompressed size validate on archive read.
- Corrupt assets make the archive invalid or explicitly degraded according to a defined recovery policy.
- A save recalculates integrity metadata from actual bytes.
- Duplicate-by-content detection/deduplication may be used where practical, but stable asset IDs remain the reference contract.

## Media types and preview safety

- Never trust filename extension alone.
- Declared media type and detected/sniffed type conflicts follow an explicit safe policy.
- Unknown/untrusted types default to opaque file handling.
- Active content is never executed as application code.
- HTML/SVG/office/PDF preview, if supported, must use a sandboxed/safe renderer appropriate to that format.
- Export preserves original bytes unless a deliberate conversion feature says otherwise.

## Extraction safety

Archive extraction must:

- derive directories from validated stable IDs;
- reject IDs/path components capable of traversal;
- never join raw display filenames into extraction paths;
- use fixed internal names such as `content` and `metadata.json`;
- ensure final paths remain inside the session workspace.

## Update behavior

Application-definition update may:

- add assets;
- replace bytes for the same stable asset ID;
- remove assets after dependency validation.

Removing a referenced application asset must be blocked or require explicit dependent-object repair.

Runtime-definition updates may replace application assets, but must not mutate installation-owned business records.

## Backup and restore

Application assets are included in:

- local `.ixt` checkpoints;
- developer cloud archive checkpoints;
- published runtime definitions as required by the app.

Restoring a developer checkpoint restores its application assets with the corresponding application definition.

Runtime installation SQLite backup does not imply a separate record-attachment feature in MVP.

## Limits and accounting

Before cloud publish/backup, size reporting includes application assets and identifies the largest archive entries.

Per-file and total limits must fail before destructive partial import/upload.

## Acceptance criteria

- Application asset bytes round-trip through archive save/open with checksum verification.
- Corrupt asset checksum/size is detected.
- Crafted IDs/filenames cannot escape the recovery workspace.
- Renaming display filename does not change identity/references.
- Replacing an asset by stable ID updates content without rewriting references.
- Deleting a referenced asset produces dependency impact.
- Runtime definition update can replace app assets without replacing installation-owned SQLite records.
- Cloud/archive size accounting includes application assets.
- Product UI/docs do not expose record-linked attachments as an MVP capability.

## Deferred: record-linked attachments

A future PRD must define at least:

- record ownership/reference model;
- SQLite/PostgreSQL storage strategy;
- local/cloud object storage options;
- backup/restore semantics;
- quotas and security;
- cross-installation behavior.

Implementors must not opportunistically add a partially specified record-attachment subsystem to MVP.

## Non-goals

- record-linked/business-record attachments in MVP;
- cloud document-management platform;
- collaborative attachment editing;
- executing embedded macros/scripts.
