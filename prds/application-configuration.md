# PRD: Application Configuration & Object Model

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the canonical application-definition model used by Studio and Runtime, its identity/reference rules, projections, validation stages, and schema migration contract.

## Canonical model

`DocumentConfig` JSON stored in the archive is the canonical application-definition model.

The working session exposes two projections:

- `document.json`: canonical JSON projection for inspection/tooling;
- `config.yaml`: human/code-first YAML projection.

Neither working file is independently authoritative after a successful archive save. Both project the same in-memory `DocumentConfig`.

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

Every referencable application object must have an immutable stable ID.

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

Deleting a referenced object requires either:

- explicit cascading deletion of declared dependents;
- explicit reference repair/rebinding; or
- cancellation.

Silent dangling references are prohibited.

## YAML projection

### Serialization

- YAML serialization is deterministic.
- Stable object ordering should minimize diff churn where ordering is not semantically meaningful.
- Secret values are never written in plaintext.
- Unsupported/unknown config fields must follow an explicit compatibility policy; they must not be silently discarded by a harmless load/save round-trip.

### Loading

Applying YAML is transactional at the config level:

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

Studio editing may temporarily permit incomplete draft objects when the editor can represent them safely. Publish/runtime export requires zero blocking errors.

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
- JSON → YAML → JSON is semantically stable.
- Invalid YAML never partially replaces active config.
- Unsupported future config/design versions fail clearly.
- Secrets do not appear in `document.json`, `config.yaml`, logs, or normal archive config rows.
- A golden application can be reconstructed from config + RecordStore schema/data without hidden hard-coded definitions.
- Publish/export validation reports all blocking configuration errors in one actionable result where practical.

## Non-goals

- arbitrary user-defined config database tables;
- storing business records in `DocumentConfig`;
- arbitrary JavaScript/Python/Lua in configuration;
- multi-developer merge semantics;
- using display names as durable references.
