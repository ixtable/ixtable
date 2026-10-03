# Decision records

Each record explains one architecture decision for the ixtable desktop app:
the context, the decision, its consequences, its status, and the tests that
prove it. PRD §28 Phase 0 requires a written record and automated proof for
every risk-retirement spike. This index maps each spike to its record.

| Record | Phase 0 spike | Status |
|---|---|---|
| [Archive format and recovery](./archive-format.md) | `.ixt` read, write, autosave. Crash-safe atomic checkpoint with large assets | accepted |
| [Shared grid model](./grid-model.md) | grid schema and CSS Grid renderer | accepted, dashboards in progress |
| [DuckDB read path](./duckdb-read-path.md) | DuckDB reads over SQLite and PostgreSQL on three OSes. Reproducible extension packaging | accepted on Linux, macOS and Windows pending CI |
| [RecordStore capabilities](./recordstore-capabilities.md) | PostgreSQL write path and read-after-write consistency | accepted |
| [Type matrix](./recordstore-type-matrix.md) | RecordStore and DuckDB logical-type compatibility | accepted |
| [Report engine](./report-engine.md) | freeform report pagination and PDF | accepted |
| [Runtime bundles](./runtime-bundles.md) | password-protected manual runtime bundle | accepted, cloud bundles out of scope |
| [Async trigger queue](./async-trigger-queue.md) | local async trigger queue | accepted |
| [Expression language](./expression-language.md) | none. Records the PRD §17.1 language design | accepted |
| [Cloud architecture](./cloud-architecture.md) | none. ixtable Cloud control plane: schema, RLS, functions, local stack | accepted (foundation) |
| [Cloud security model](./cloud-security-model.md) | signed personalized bundle and envelope-encryption threat model | accepted, external review pending |

The Phase 0 item "signed personalized bundle and envelope-encryption threat
model" belongs to ixtable Cloud. The desktop work does not build it. The
[runtime bundles](./runtime-bundles.md) record lists the limits of the local
design that the cloud design must address.

## Writing a record

Name the file after the decision, in kebab case, and use these sections:

| Section | Contents |
|---|---|
| Status | `accepted`, `in progress`, or `superseded by <record>`, with the PRD sections it covers |
| Context | the problem and the constraints from the PRD |
| Decision | what the code does, with file and function names |
| Consequences | what the decision costs and what it rules out |
| Evidence | the test files that prove it. CI runs them on Windows, macOS, and Linux through `.github/workflows/desktop.yml` |

Update the record in the same change that alters the decision. A record that
no longer matches the code is a bug.
