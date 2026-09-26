# PRD: Cross-platform QA, Security & Release Gates

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define evidence required before an MVP feature or release is considered complete across Windows, macOS, Linux, local operation, and paid cloud workflows.

## Test layers

### Deterministic automated tests

Must cover:

- archive open/save/recovery/migration;
- RecordStore conformance;
- DuckDB read consistency;
- schema/migrations;
- CRUD;
- layout serialization;
- forms;
- reports/PDF golden output;
- dashboards;
- expressions/actions/triggers;
- attachment integrity;
- runtime bundle update/rollback;
- authentication/RBAC;
- cloud publish/update/restore;
- billing entitlement transitions.

### Golden applications

Three applications are mandatory public-feature-only fixtures:

- CRM;
- Inventory;
- Work Orders.

No hidden special-case implementation is permitted for them.

### Agent-driven QA

Agents may execute declared end-user journeys and provide screenshots/logs/reproduction evidence. Agent judgment blocks CI only when converted into a deterministic assertion or reproducible artifact.

## Platform matrix

Windows, macOS, and Linux are release-blocking.

A feature is not “supported” until its required tests pass on all supported platforms or the parent PRD explicitly scopes it otherwise.

## Security gates

Required before commercial release:

- no plaintext datasource secrets in archives/config/logs;
- signed bundles fail closed;
- authorization checked at runtime entry points;
- extraction/path traversal defenses;
- approved cryptographic libraries only;
- dependency and secret scanning;
- external review of credential/key-grant design;
- no unresolved critical/high findings.

## Performance/accessibility

Validate parent-PRD targets for:

- warm open;
- field edit acknowledgement;
- autosave;
- runtime navigation;
- long query cancellation/progress;
- keyboard access;
- visible focus;
- semantic labels;
- built-in theme contrast.

## Release evidence

Each release candidate should produce:

- CI matrix result;
- golden app journey result;
- migration fixture result;
- report/PDF golden result;
- signed installer/update verification;
- security gate status;
- known limitations.

## Acceptance criteria

Commercial launch remains blocked until every launch acceptance criterion in the parent PRD has reproducible evidence.

## Non-goals

- replacing deterministic tests with agent opinions;
- treating one OS as representative of all desktop platforms;
- accepting undocumented security exceptions.
