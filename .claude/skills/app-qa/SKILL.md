---
name: app-qa
description: Visually verify ixtable UI and interaction changes with real React rendered in jsdom, user-event interactions, the tauri-test Rust bridge, and Chromium screenshots. Use for /app-qa, screenshot requests, and after any user-facing UI change.
---

# App QA

Use this skill after changing `src/**`, UI-facing `src-tauri/**` commands, or shared styling. Keep it generic: add scenarios as the product grows rather than coupling the harness to today's Projects screen.

## Invariants

- Render production components in jsdom. Do not build a lookalike fixture.
- Never start Vite, Tauri dev, or another live server for `/app-qa` screenshots. Live-server screenshots belong only to `/service-qa` and `/web-qa`.
- Serialize the jsdom-rendered production DOM with `captureDocument`; Chromium may rasterize that static capture, but it must not navigate to a running application URL.
- Drive every interaction with `@testing-library/user-event`; never use `fireEvent`.
- Use accessible roles/names where possible.
- Keep real DOM assertions alongside screenshots.
- Use the real `tauri-test` bridge for Rust-backed flows. Mock only external systems outside the contract being verified.
- Every capture has 1–3 plain-English visual expectations.

## Workflow

1. Identify the user-visible behavior and the smallest meaningful before/after path.
2. Reuse or extend `scripts/screenshot/specs/<flow>.spec.tsx`. Keep specs as visual regression coverage.
3. Render the real component, assert the DOM reached the intended state, and interact only through `userEvent`.
4. Call `captureDocument(document, {name, expectations})`. Use stable names such as `<flow>-01-before` and `<flow>-02-after`.
5. Run `npm run screenshot` after Rust, dependency, or CSS changes. For quick iteration after CSS is built, run `npx vitest run --config vitest.screenshot.config.ts <spec>`.
6. Read each generated JSON manifest and inspect its PNG against every expectation. Passing assertions do not prove the pixels are correct.
7. Send the PNGs to the user with `treq send <path>` and report any mismatch.
8. Finish with `npm test` and `npm run build`.

Generated artifacts live under `scripts/screenshot/.generated/` and are intentionally ignored. `captureDocument` serializes jsdom's DOM, inlines the production Vite/Tailwind CSS, and uses Chromium only to rasterize pixels.

If a browser-only widget cannot be captured from serialized jsdom, treat that as an App QA harness gap. Fix the harness or report the mismatch; do not replace the App QA proof with a live-server screenshot.
