# PRD: Attachments & Application Assets

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define storage, lifecycle, integrity, and update behavior for application-definition assets and record attachments.

## Two attachment classes

### Application assets

Examples: logos, images used in forms/reports, bundled reference files.

- Stored inside the `.ixt` archive.
- Versioned with the application definition.
- Addressed by stable IDs.
- Include MIME type, size, and checksum metadata.
- Autosaved into the archive as application definition changes.

### Record attachments

Attachments associated with user records are record state, not app-definition state.

For embedded SQLite runtime installations, record attachments remain local installation data and must survive definition updates.

## Integrity

- Content checksums are mandatory.
- Missing/corrupt assets produce explicit validation/runtime errors.
- Unknown MIME types are treated as opaque downloads unless explicitly supported.
- File names are metadata, not storage identity.

## Security

- Never trust extension alone for MIME handling.
- Prevent path traversal during extraction.
- Do not execute embedded attachment content.
- Apply size limits and safe preview behavior.
- Secrets are not stored as ordinary attachments.

## Update behavior

- Definition updates may add/replace/remove application assets.
- Runtime-local record attachments are not overwritten by definition updates.
- Restore semantics clearly distinguish app assets from runtime record attachments.

## Acceptance criteria

- Asset checksum corruption is detected.
- Archive extraction cannot escape the working directory.
- Replacing a definition asset updates references by stable ID.
- Runtime-local record attachments survive application-definition upgrade/rollback.
- Size accounting includes assets before cloud publish.

## Non-goals

- cloud document management;
- collaborative attachment editing;
- executing embedded macros/scripts.
