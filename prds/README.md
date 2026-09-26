# ixtable PRDs

This directory contains the product requirements hierarchy for ixtable.

## How to use these documents

- **[commercial-mvp.md](./commercial-mvp.md)** is the product-level source of truth for MVP scope, commercial boundaries, release gates, and non-goals.
- Sub-PRDs define implementation contracts for major subsystems.
- Sub-PRDs may add detail but must not silently expand or contradict the commercial MVP.
- If two sub-PRDs conflict, resolve the conflict explicitly in both documents and, where necessary, update the parent PRD.
- Implementation work should link the relevant PRD and acceptance criteria in issues and pull requests.
- Architecture decisions that materially alter a PRD contract should be captured as an ADR and then reflected back into the PRD.

## MVP sub-PRDs

1. [Application Archive & Lifecycle](./application-archive-and-lifecycle.md)
2. [Application Configuration & Object Model](./application-configuration.md)
3. [RecordStores & Schema](./recordstores-and-schema.md)
4. [DuckDB Read & Query Engine](./duckdb-read-and-query-engine.md)
5. [Shared Grid, Forms & Navigation](./forms-layout-and-navigation.md)
6. [Reports, Charts & Dashboards](./reports-and-dashboards.md)
7. [Expressions, Actions & Triggers](./expressions-actions-and-triggers.md)
8. [Application Assets](./attachments-and-assets.md)
9. [Runtime Bundles & Manual Distribution](./runtime-bundles-and-manual-distribution.md)
10. [Cloud Publishing, Auth & RBAC](./cloud-publishing-auth-and-rbac.md)
11. [Cloud Backup, Updates & Recovery](./cloud-backup-updates-and-recovery.md)
12. [Billing, Entitlements & Commercial Operations](./billing-entitlements-and-operations.md)
13. [Cross-platform QA, Security & Release Gates](./qa-security-and-release-gates.md)

## Deferred PRDs

The parent PRD explicitly requires separate future PRDs before implementation for:

- Microsoft Access interoperability and migration
- SQLite multi-user synchronization/conflict resolution
- browser/mobile runtimes
- AI-assisted application building and migration
- self-hosted cloud
- multi-developer collaboration/branching/merge
- additional transactional RecordStores
- enterprise identity/OIDC/governance

These are not MVP sub-PRDs and should not be implemented opportunistically.
