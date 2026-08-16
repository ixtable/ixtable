---
name: service-qa
description: Verify the ixtable SaaS platform services exposed through authenticated Docusaurus pages, using local SaaS dependencies and a served website. Do not use for Tauri or local desktop application QA.
---

# SaaS Service QA

Use this skill after changing the SaaS platform, Supabase migrations/functions, authentication, account services, API adapters, or other service boundaries consumed by auth-walled Docusaurus pages. It does not validate the local Tauri application.

## Relationship to app-qa

- `/app-qa` validates the local Tauri application, including its Rust bridge, through jsdom.
- `/web-qa` validates public Docusaurus pages and general responsive website behavior.
- `/service-qa` validates SaaS contracts and authenticated Docusaurus flows against real local SaaS dependencies.
- Never use `/service-qa` as evidence for a desktop application change.

## Invariants

- Test real local SaaS services only. Never point QA at production.
- Exercise services through the authenticated Docusaurus UI or the same client adapter used by that UI.
- Do not invoke Tauri commands, compile the Rust bridge, or render the desktop application.
- Use the documented local Supabase stack and deterministic test accounts for auth-walled flows.
- Prefer isolated fixtures with deterministic setup and teardown.
- Record each result with `recordOutcome(name, {expectations, details})`.
- Never expose secrets or store live tokens in generated artifacts.
- Service screenshots must come from the locally served Docusaurus production build driven in Chromium, not from serialized jsdom or a diagnostic fixture.
- Capture authenticated product pages that consume the service result, not standalone service-status mockups.

## Workflow

1. Identify the changed SaaS contract, authenticated page, test user, expected result, error behavior, and side effect.
2. Reuse or extend the service-focused Playwright specs under `web/e2e/`; keep authentication and fixture helpers deterministic.
3. Start the documented local Supabase stack and seed the required test account and data. Never substitute a handwritten service mock.
4. Build and serve the Docusaurus production site locally, then drive the auth-walled flow with Playwright Chromium.
5. Assert the service result and persistent side effects, then capture the production page with 1–3 plain-English visual expectations.
6. Inspect every result manifest and PNG. Confirm the screenshot shows the authenticated SaaS result rather than a diagnostic substitute.
7. Send relevant PNGs with `treq send <path>` and summarize the verified SaaS contract.
8. Finish with the Docusaurus typecheck, production build, and relevant service specs.

Keep SaaS service adapters with the Docusaurus application and service QA helpers under `web/e2e/`. Do not add desktop/Tauri coverage to `scripts/service-qa/`; migrate obsolete desktop service checks to `/app-qa` or ordinary Rust tests.
