# PRD: Attachments & Application Assets

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define storage, lifecycle, integrity, safety, backup, and update behavior for application-definition assets and record attachments without conflating the two.

## Attachment classes

### 1. Application assets

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

### 2. Record attachments

Examples:

- invoice PDF attached to an invoice row;
- work-order photo;
- customer-provided document.

Record attachments are business record state.

They are not stored in the archive's application-asset table merely because the UI calls both concepts “attachments.”

Their backend follows the owning RecordStore/runtime installation contract.

For embedded SQLite Runtime, record attachments belong to the installation-local data state and survive application-definition updates.

For PostgreSQL applications, the attachment storage strategy must be explicitly configured; the MVP must not falsely imply that ixtable Cloud backs up developer-owned external record attachment storage.

## Identity and references

- Asset/attachment stable ID is storage identity.
- Display filename is mutable metadata.
- User-supplied path/filename never determines extraction path.
- Definition objects reference application assets by stable ID.
- Record attachment ownership references stable record identity/key according to the RecordStore model.

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

For application assets:

- checksum and uncompressed size validate on archive read;
- corrupt assets make the archive invalid or explicitly degraded according to a defined recovery policy;
- a save always recalculates integrity metadata from actual bytes.

For record attachments:

- integrity metadata is required when stored/managed by ixtable;
- backup/restore verifies attachment integrity where included.

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

Runtime-definition updates must never overwrite installation-local record attachments.

## Backup and restore

### Editable/local archive

Application assets are naturally included in `.ixt` checkpoints.

### Runtime SQLite backup

Where optional cloud backup of runtime SQLite state is enabled, record attachments managed as part of that installation's state are included consistently with the corresponding record checkpoint.

### PostgreSQL/external storage

The product must clearly state what is and is not backed up. Application-definition asset backup does not imply external record attachment backup.

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
- Runtime local record attachments survive definition upgrade/rollback.
- SQLite runtime backup restores record data and managed record attachments consistently.
- Cloud UI never describes external PostgreSQL attachment data as backed up unless it actually is.
- Archive size accounting includes application assets.

## Non-goals

- cloud document-management platform;
- collaborative attachment editing;
- executing embedded macros/scripts;
- treating application assets and business record attachments as one storage table.
