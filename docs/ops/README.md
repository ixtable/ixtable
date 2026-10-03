# ixtable Cloud operations

Runbooks for the hosted control plane (Supabase project + Stripe). The
architecture is in `docs/decisions/cloud-architecture.md`; the security
model in `docs/decisions/cloud-security-model.md`.

| Document | Use it for |
|---|---|
| [monitoring.md](monitoring.md) | health probe, service metrics, alert rules and thresholds, rate limits |
| [backups.md](backups.md) | database PITR, archive storage versioning, restore drills |
| [incidents.md](incidents.md) | severity levels, first response, playbooks per failure |
| [support-runbook.md](support-runbook.md) | diagnosing distribution, key-grant and billing problems with `admin-support`, without viewing secrets |

Rules that apply everywhere:

- Never paste secrets (KEKs, signing key, Stripe keys, user tokens, DEKs)
  into tickets, chat or logs. Nothing in these runbooks needs them.
- Operators work through `admin-support` and read-only SQL on the metrics
  and audit tables. Writes go through Edge Functions or a reviewed
  migration, never ad-hoc `UPDATE` on customer rows.
- Every operator lookup is audited (`admin.lookup`) and visible to the app
  owner in the audit history.
