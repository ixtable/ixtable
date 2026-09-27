# PRD: Application Configuration & Object Model

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the canonical application-definition model used by Studio and Runtime, its identity/reference rules, projections, validation stages, and schema migration contract.

## Canonical model

`DocumentConfig` is the runtime/internal strongly typed Rust structured application-definition model, but ixtable supports **two mutually exclusive authoring modes**:

1. **Studio-managed mode** — the archived `DocumentConfig` is authoritative and Studio may edit the application definition.
2. **YAML IaC mode** — an explicitly supplied `config.yaml` is the authoritative application definition. Studio may inspect, preview, validate, and run the app, but application-definition editing is read-only in the in-app designer.

The working session may expose:

- `document.json`: normalized JSON projection for inspection/tooling;
- `config.yaml`: the IaC source when YAML mode is enabled, otherwise an exported/generated projection.

In YAML IaC mode, Studio must never silently rewrite the authoritative YAML as a side effect of visual editing because visual application-definition editing is disabled.

## Versioning

`DocumentConfig.version` versions the configuration schema only.

It must not be reused as:

- archive format version;
- design schema version;
- app release version; or
- ixtable desktop version.

Nested versioned schemas such as the design schema retain their own version fields and validators.

## MVP object model

`DocumentConfig` must evolve to contain stable-ID definitions for:

- application name/mode/settings;
- navigation;
- saved queries and query parameters;
- design schema and shared layouts;
- forms;
- reports;
- dashboards;
- expressions;
- actions;
- triggers;
- datasource definitions;
- runtime roles/object permissions;
- application migrations;
- dependency metadata;
- application release/version metadata.

RecordStore-owned relational schema remains outside `DocumentConfig`.

## Stable identity

Every referencable application object must have an immutable stable ID generated as UUIDv7 unless an imported supported definition already provides a valid stable ID.

Rules:

- display names are user-editable labels, not identity;
- references serialize stable IDs;
- rename never rewrites dependent references merely because a label changed;
- duplicate stable IDs are invalid;
- object type + stable ID must resolve unambiguously;
- newly created IDs must not be derived from display names;
- generated CRUD objects use the same identity scheme as hand-authored objects.

## Dependency graph

The configuration layer must expose dependency analysis across application objects.

At minimum it must support:

- inbound references to an object;
- outbound references from an object;
- invalid/dangling references;
- publish/export blockers;
- deletion impact preview.

Deletion cascades automatically only for true owned-child relationships declared by the schema. Shared/reused dependencies block deletion until the developer repairs/rebinds them or explicitly removes those dependents. Silent dangling references are never created.

Silent dangling references are prohibited.

## YAML projection

### Authoring mode selection

An application explicitly created/opened with a supplied authoritative YAML definition enters **YAML IaC mode**. YAML IaC supports one root YAML file with explicit imports/includes of additional YAML files; the include graph must be deterministic, cycle-checked, path-safe, and resolved before transactional validation.

Required behavior:

- the YAML file is the source of truth for application-definition changes;
- Studio definition editors are read-only;
- Runtime/data editing remains available according to normal permissions;
- reloading/applying changed YAML performs the full transactional validation pipeline before replacing the active normalized `DocumentConfig`;
- invalid YAML leaves the last valid normalized definition active and reports the source error;
- switching between Studio-managed and YAML IaC modes must be an explicit conversion/export operation, never an implicit side effect.

### Serialization

- YAML serialization is deterministic.
- Stable object ordering should minimize diff churn where ordering is not semantically meaningful.
- Secret values are never written in plaintext.
- Unknown fields inside a supported schema version are preserved where structurally possible and must not be silently discarded by a harmless load/save round-trip.

### Loading

Applying/reloading authoritative YAML is transactional at the config level:

1. parse the complete YAML;
2. deserialize to the expected config schema;
3. validate version compatibility;
4. validate nested schemas;
5. validate stable IDs/references;
6. validate semantic constraints;
7. only then replace active in-memory config.

Any failure leaves the previous valid config active.

## Validation pipeline

Validation has four required stages:

1. **Schema** — data shapes, required values, supported versions.
2. **Identity/reference** — unique stable IDs and resolvable references.
3. **Semantic** — object-specific constraints and RecordStore/datasource capability compatibility.
4. **Distribution** — requirements that may be valid locally but block runtime export/publish, such as missing credentials, unresolved permissions, unsupported migrations, or invalid dependencies.

Studio-managed mode may persist incomplete/temporarily invalid draft definitions into local autosave checkpoints when the editor can represent them safely. Runtime execution of affected objects and publish/runtime export remain blocked until blocking validation errors are resolved.

## Secrets and datasource configuration

`DocumentConfig` may contain datasource definitions and credential references, but never plaintext protected credentials.

Credential material must live in the credential mechanism appropriate to local/manual/cloud execution and be referenced by stable opaque identifiers.

## Migration

- Config migrations are explicit, ordered, deterministic transforms.
- Migrations validate the output before committing it to the active session.
- A migration may delegate nested versioned structures to their own migrators.
- Unsupported future config versions fail without partial interpretation.
- Downgrade requires an explicit reverse transform.
- Migration fixtures must include at least the oldest supported source version, current version, malformed input, and future-version rejection.

## Implementor contract

Feature code must not add an ad hoc second configuration store for application definitions.

If a feature needs durable definition state, it should normally extend `DocumentConfig` or a deliberately versioned nested schema referenced by it. Exceptions require an architecture decision because they affect archive portability and migration.

## Acceptance criteria

- Renaming any stable-ID object leaves all references valid.
- Duplicate IDs are rejected.
- Deleting a referenced object produces an exact impact list.
- Studio-managed JSON → exported YAML → normalized JSON is semantically stable.
- In YAML IaC mode, application-definition editors are read-only and external YAML changes are the only supported definition-edit path.
- Invalid YAML never partially replaces active config.
- Unsupported future config/design versions fail clearly.
- Secrets do not appear in `document.json`, `config.yaml`, logs, or normal archive config rows.
- A golden application can be reconstructed from config + RecordStore schema/data without hidden hard-coded definitions.
- Publish/export validation reports all blocking configuration errors in one actionable result where practical.

## Non-goals

- arbitrary user-defined config database tables;
- mandatory directory/project layouts beyond the root YAML + optional explicit includes;
- storing business records in `DocumentConfig`;
- arbitrary JavaScript/Python/Lua in configuration;
- multi-developer merge semantics;
- using display names as durable references.
