# PRD: Application Configuration & Object Model

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the canonical application-definition model used by Studio and Runtime.

## Canonical model

`DocumentConfig` is the structured application catalog stored as JSON in the archive. It is the canonical definition model for application objects.

The YAML file is a code-first projection of the same model, not an independent source of truth.

## Required object categories

The config model must support stable-ID objects for:

- application metadata and navigation;
- saved queries and parameters;
- forms and shared layouts;
- reports and dashboards;
- expressions;
- actions and triggers;
- datasource definitions;
- runtime roles and object permissions;
- migrations;
- dependency metadata; and
- application version metadata.

Record schema itself remains owned by the selected RecordStore.

## Identity and references

- Every application object has an immutable stable ID.
- Display names are mutable and must never be used as identity.
- References between objects use stable IDs.
- Deletion must perform dependency analysis and block or repair dangling references.
- Rename must not alter references.

## YAML projection

- Loading valid YAML replaces the in-memory `DocumentConfig`.
- Saving config rewrites YAML deterministically.
- Invalid YAML or schema-invalid YAML never partially applies.
- YAML round-tripping should minimize unnecessary churn.
- Secrets must not be serialized in plaintext into YAML.

## Validation

Validation occurs at three levels:

1. schema validity;
2. reference/dependency validity;
3. semantic validity, such as datasource capabilities or invalid action targets.

Publishing and runtime-only export require a fully valid application definition.

## Migration

- Config schema versions are explicit.
- Product upgrades migrate config deterministically.
- Unsupported downgrade paths fail without mutating the source archive.
- Migration tests use versioned fixtures.

## Acceptance criteria

- Renaming an object never breaks references.
- Deleting a referenced object produces an impact list.
- JSON → YAML → JSON is semantically stable.
- Invalid YAML leaves the last valid config active.
- A complete golden application can be reconstructed from the config model without hidden hard-coded definitions.

## Non-goals

- arbitrary user-defined config tables;
- storing record data in `DocumentConfig`;
- arbitrary JavaScript in configuration;
- multi-developer merge semantics.
