# Release gates

This page maps every release gate in PRD §21.3 (credential delivery), §27.2
(security) and the Phase 5 exit criteria to an automated check or a named
human sign-off. A public release ships only when every automated gate passes
and every sign-off is recorded.

The per-release runbook (version bump, tagging, manual install checks,
publishing, rollback) is [release/checklist.md](./release/checklist.md). This
page lists the gates. The runbook is how one release gets through them.

## Run the gates

```bash
node scripts/ci/release-gates.mjs          # table; exit 1 if an automated gate fails
node scripts/ci/release-gates.mjs --json   # machine-readable
```

The script checks the repository, so it runs offline in a few seconds. It
prints each human sign-off as `PENDING`. Desktop CI runs it in the `lint`
job, and `release.yml` runs it in the `plan` job, so a tag cannot build while
an automated gate fails. Sign-offs are enforced by the required reviewers on
the `release-beta` and `release-stable` GitHub environments: approving the
`publish-update-manifest` job is the sign-off record for that release.

`tests/unit/release-gates.test.ts` fails if this page and the script list
different gates.

## Automated gates

Each check looks for the code, workflow step, or test that enforces the
gate. The tests themselves run in Desktop CI and Cloud contracts CI.

| Gate | PRD | What is checked | Where it is enforced |
|---|---|---|---|
| `no-plaintext-credentials` | §27.2 | The credential store encrypts with XChaCha20-Poly1305, and an integration test proves the password never lands in the document | `recordstore/secrets.rs`, `tests/integration/datasource.test.tsx` |
| `no-custom-crypto` | §21.3, §27.2 | Every crypto dependency in `Cargo.toml` and `package.json` is on `ALLOWED_CRYPTO_CRATES` (ed25519-dalek, chacha20poly1305, argon2, sha2, rustls, and so on) | `scripts/ci/release-gates.mjs` |
| `updates-fail-closed` | §27.2 | `release.yml` runs the signing gate, the key pair probe, the embedded key check, and signature verification, in that order. Updater endpoints are https. The updater tests reject foreign signatures | `scripts/release/signing.mjs`, `scripts/release/keys.mjs`, `src-tauri/src/updater/tests.rs` |
| `bundles-fail-closed` | §27.2 | A build with no pinned cloud key refuses every install (`CLOUD_KEY_MISSING`). Release builds take the key from `vars.IXTABLE_CLOUD_PUBLIC_KEY_RAW` | `src-tauri/src/cloud/config.rs`, `release.yml` |
| `no-committed-private-keys` | §27.2 | No tracked file is a PEM private key, a minisign or Tauri secret key, or a `.p12`, `.pfx`, `.p8`, or `.key` file | `scripts/ci/release-gates.mjs` |
| `private-by-default` | §27.2 | The RLS private-by-default contract spec exists and Cloud contracts CI runs the contract specs | `web/e2e/service-qa/specs/rls-private-by-default.spec.ts`, `cloud.yml` |
| `runtime-authorization` | §27.2 | Role and trigger authorization tests exist | `tests/integration/runtime-rbac*.test.tsx`, `src-tauri/src/trigger_auth_tests.rs` |
| `log-redaction` | §27.2 | `logging::redact` exists and has unit tests | `src-tauri/src/logging.rs` |
| `key-renewal-24h` | §21.3 | Key grants live 24 hours | `supabase/functions/_shared/credentials.ts` (`GRANT_TTL_MS`) |
| `three-os-ci` | §6.1, Phase 5 | The Desktop test and golden jobs, and the release `gates` job, run on Windows, macOS, and Linux | `desktop.yml`, `release.yml` |
| `signed-installers` | Phase 5 | macOS codesign, notarization, and Gatekeeper checks, Windows Authenticode checks, signing secrets for both, and an update manifest covering all four targets | `release.yml`, `scripts/release/signing.mjs`, `scripts/release/update-manifest.mjs` |
| `versions-agree` | Phase 5 | `tauri.conf.json`, `package.json`, and `Cargo.toml` carry one version | `scripts/release/plan.mjs` |
| `operations-docs` | Phase 5 | The security, monitoring, backup, incident, support, and production-config documents exist | `docs/release/security.md`, `docs/ops/` |

## Human sign-offs

| Gate | PRD | Owner | Done when |
|---|---|---|---|
| `external-security-review` | §21.3, §27.2 | Security lead | An independent reviewer has assessed the envelope-encryption and signed-bundle design in [the cloud security model](./decisions/cloud-security-model.md). The report and the fix list are linked from that record, and every high finding is fixed |
| `key-ceremony` | §27.2, Phase 5 | Two maintainers | The production updater key and cloud bundle-signing key are generated offline. The secrets and variables listed in [desktop updates](./decisions/desktop-updates.md) are set, offline backups exist, and the ceremony (date, people, key fingerprints) is recorded. The release key gate passes on a beta run |
| `green-ci-all-os` | Phase 5, §29 | Release manager | Desktop CI and Cloud contracts CI are green on Windows, macOS, and Linux for the release commit, with no job left non-blocking. The release issue links the runs |
| `install-signoff` | Phase 5 | Release manager | Section 3 of [the runbook](./release/checklist.md) is complete for all three OSes, including the fail-closed update check |
| `production-cloud-config` | §27.2, Phase 5 | Operator | The go-live list in [production config](./ops/production-config.md) is complete, including a desktop build pinning the production cloud key |
| `self-service-journey` | Phase 5 | Product owner | A new customer registers, pays, publishes, invites, runs, updates, restores, and cancels on production without operator action, and the evidence is recorded |
| `support-without-secrets` | Phase 5 | Support lead | A staged distribution failure and a staged key-grant failure are diagnosed with [the support runbook](./ops/support-runbook.md) without viewing secrets |
| `commercial-terms` | Phase 5 | Legal | The terms and privacy policy describe the trusted-user security model (PRD §21.3: revocation cannot erase credentials an authorized user already saw) |

## Adding a gate

Add an entry to `GATES` in `scripts/ci/release-gates.mjs`, with a `check`
function or a `signoff` text, and add a row to the matching table above.
