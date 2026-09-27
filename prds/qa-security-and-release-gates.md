# PRD: Cross-platform QA, Security & Release Gates

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define reproducible evidence required before a subsystem, release candidate, or commercial MVP release is considered complete across Windows, macOS, Linux, local operation, and paid cloud workflows.

## Principle

“Implemented” means behavior is demonstrated by appropriate automated/reproducible evidence.

A merged UI or happy-path demo is not sufficient when the feature contract includes persistence, migration, failure recovery, security, or cross-platform behavior.

## Test layers

### 1. Unit/property tests

Use for:

- serializers/parsers;
- version validation;
- expression semantics;
- dependency graphs;
- logical type conversions;
- permission evaluation;
- checksums/signatures;
- migration ordering;
- entitlement state machines.

Property/fuzz testing should be used for parsers/archive boundaries and other input-heavy security surfaces where practical.

### 2. Subsystem integration tests

Required for:

- archive save/open/recovery;
- RecordStore conformance;
- DuckDB read-after-write;
- schema migration;
- runtime bundle install/update/rollback;
- cloud publish/download;
- auth/RBAC;
- backup/restore;
- billing event/entitlement processing.

Tests exercise real subsystem boundaries rather than mocking away the contract under test.

### 3. Golden artifact tests

Required for deterministic serialized/output artifacts:

- archive fixtures by version;
- config/design fixtures;
- report/PDF output;
- migration fixtures;
- runtime bundle metadata;
- signed update metadata.

Golden updates require review; tests must not auto-approve changed golden output.

### 4. End-to-end journeys

Exercise user-visible workflows through the actual product surface.

At minimum cover:

- create local app → schema → form → CRUD → save/reopen;
- manual runtime export → install → local data → update;
- cloud publish → invite → authenticate Runtime → receive app → use role;
- update published app → Runtime update → preserved local state;
- backup → restore;
- subscribe → quota enforcement → cancel/export.

## Golden applications

Three public-feature-only applications are mandatory:

- CRM;
- Inventory;
- Work Orders.

Rules:

- no hidden fixture-only runtime code;
- no hard-coded domain mode;
- each uses ordinary application primitives;
- fixtures include deterministic seed data;
- declared journeys cover schema, forms, queries, reports/dashboard/automation as they become available.

If a golden app requires a special case, either generalize it into a supported product feature or remove the special case.

## Agent-driven QA

Agents may explore and execute declared journeys using app/web/service QA tooling.

Agent evidence may include:

- screenshots;
- structured logs;
- network/service traces;
- reproduction steps;
- generated deterministic assertions.

Subjective agent judgment alone does not block CI.

A finding becomes release-blocking when represented by:

- deterministic failing assertion;
- reproducible crash/data loss/security issue;
- accepted human-reviewed release blocker.

## Platform matrix

Release-blocking desktop matrix:

- Windows;
- macOS;
- Linux.

Architecture-specific extension/installer artifacts are separately validated where shipped.

A desktop feature is supported only when its applicable integration/E2E tests pass on every supported target.

Platform exceptions require explicit parent/sub-PRD scope change, not a skipped test with no rationale.

## Database matrix

RecordStore/DuckDB conformance includes at least:

- supported SQLite version bundled/used by product;
- supported PostgreSQL version range defined for release.

Tests cover shared logical types, constraints, migrations, read-after-write, and normalized errors.

## Failure-injection requirements

Release evidence must exercise failures, not only happy paths.

At minimum simulate:

- process termination during archive save;
- corrupt archive payload/asset;
- external file conflict;
- migration failure;
- DuckDB extension integrity/startup failure;
- Runtime update interruption;
- backup upload interruption/digest mismatch;
- expired/revoked authorization;
- duplicate/out-of-order billing events;
- temporary cloud/storage/provider outage.

## Security gates

Before commercial release:

- no plaintext protected datasource credentials in archives/config/YAML/logs/support UI;
- archive extraction resists path traversal;
- signed bundle/update verification fails closed;
- authz executes at direct object/action entry points;
- cryptography uses approved reviewed libraries/designs;
- dependency vulnerability scanning;
- secret scanning;
- static analysis/lint gates appropriate to Rust/TypeScript;
- externally reviewed credential/key-grant design;
- threat models for manual bundle and cloud distribution;
- no unresolved critical/high security findings.

A security exception requires documented owner, impact, mitigation, and explicit release decision; undocumented exceptions are prohibited.

## Performance gates

Benchmark against declared reference hardware/fixtures for parent-PRD targets:

- warm app open;
- field edit acknowledgement excluding backend latency;
- autosave/checkpoint;
- loaded-page navigation;
- query cancellation/progress threshold.

Performance regressions beyond tolerance require explicit review rather than silent golden-baseline updates.

## Accessibility gates

Built-in Studio/Runtime workflows test:

- keyboard reachability;
- visible focus;
- semantic labels/names;
- built-in theme contrast;
- error association with controls;
- reports readable without reliance on color alone.

Automated accessibility checks are supplemented by keyboard journey tests for critical flows.

## Upgrade compatibility matrix

Release candidates test:

- oldest supported archive/config version → current;
- prior supported desktop version artifacts → current;
- current runtime bundle → update to release candidate;
- supported rollback cases;
- future-version rejection;
- changed historical migration checksum rejection.

Compatibility fixtures are retained across releases rather than regenerated only from current code.

## Release evidence manifest

Each release candidate produces a machine-readable/human-viewable evidence manifest containing:

- commit/build identity;
- platform CI matrix;
- unit/integration/E2E status;
- golden app journey status;
- migration compatibility matrix;
- report/PDF golden status;
- bundle/signature verification status;
- security scan/review status;
- performance benchmark summary;
- accessibility gate summary;
- known limitations/exceptions;
- links/identifiers for reproducible artifacts/logs.

## Commercial launch blockers

Launch remains blocked until the parent Commercial Launch Acceptance Criteria have evidence.

At minimum this includes proof that:

- local use requires no account;
- every application data read uses DuckDB;
- SQLite/PostgreSQL write conformance passes;
- archive recovery survives interrupted saves;
- three golden applications pass;
- report output meets golden fixtures;
- private cloud apps cannot be retrieved by unauthorized users;
- signed personalized bundles verify;
- credential grants pass security review;
- publishing is explicit;
- update failure reverts safely;
- SQLite eligible restore works;
- PostgreSQL backup limitations are accurately represented;
- billing/entitlements work end-to-end;
- export/deletion workflow operates.

## Acceptance criteria

- Every subsystem PRD acceptance criterion maps to at least one named test/evidence owner before the subsystem is declared complete.
- Release candidate has no unexplained skipped release-blocking platform tests.
- Golden app journeys execute on actual packaged/production-like builds appropriate to the layer being tested.
- Failure-injection suite demonstrates recovery/rollback outcomes.
- Release evidence manifest is generated and retained.
- Agent-only aesthetic/opinion findings do not silently become CI policy without deterministic criteria.
- Security/release exceptions are explicit and auditable.

## Non-goals

- replacing deterministic tests with agent opinions;
- treating one OS as representative of all supported desktop platforms;
- accepting undocumented security exceptions;
- defining calendar estimates or staffing plans.
