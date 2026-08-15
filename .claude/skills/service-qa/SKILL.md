---
name: service-qa
description: Verify ixtable service boundaries through real local implementations, especially Tauri Rust commands through tauri-test, and capture jsdom UI proof when a service result is user-visible. Use for /service-qa and after changing service contracts.
---

# Service QA

Use this skill after changing Tauri commands, persistence, Supabase migrations/functions, API adapters, authentication, or other I/O boundaries. The current baseline is the local Tauri command bridge; extend adapters without replacing real boundaries with mocks.

## Relationship to app-qa

- `/app-qa` proves interaction and pixels.
- `/service-qa` proves contracts and real local I/O.
- A user-facing service flow needs both: contract assertions plus a screenshot of production UI consuming the result.

## Invariants

- Test real local services only. Never point QA at production.
- Invoke Rust through the `tauri-test` N-API bridge, not a handwritten JS mock.
- Prefer isolated fixtures with deterministic setup and teardown.
- Record each result with `recordOutcome(name, {expectations, details})`.
- Never expose secrets or store live tokens in generated artifacts.
- When rendering UI, use jsdom and `userEvent`; do not substitute terminal output for screenshots.

## Workflow

1. Identify the changed contract and its caller. Decide what result, error, and side effect matter.
2. Reuse or extend `scripts/service-qa/specs/<contract>.spec.tsx`.
3. Call the real local boundary, make Vitest assertions, then write a result manifest with 1–3 reviewable expectations.
4. If the outcome is visible in the app, render the production UI and capture it with the shared screenshot harness. A diagnostic result view is acceptable only for infrastructure smoke checks and must be labeled as such.
5. Run `npm run screenshot:css`, then `npm run service-qa`. Start any documented local dependency first; fail clearly when it is unavailable rather than silently mocking it.
6. Inspect every outcome JSON. For captures, inspect every PNG against its manifest.
7. Send relevant PNGs with `treq send <path>` and summarize the verified contract.
8. Finish with `npm test` and `npm run build`.

Keep service adapters and setup helpers under `scripts/service-qa/`. Keep service QA excluded from the ordinary unit suite when it requires external processes.

