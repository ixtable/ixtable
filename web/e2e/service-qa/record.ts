/**
 * Writes the plain-English outcome checklist for each service-qa check to
 * web/e2e/service-qa/.generated/<name>.json (and <name>.png for UI captures).
 * Playwright assertions prove the contract; this file is the reviewer's
 * checklist for step 5 of the service-qa skill. Secrets are redacted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export const GENERATED_DIR = join(__dirname, ".generated");

export interface OutcomeOptions {
  /** 1-3 plain-English claims a reviewer should confirm from this run. */
  expectations: string[];
  /** Structured evidence: status codes, row ids, returned shapes. */
  details?: Record<string, unknown>;
}

const SECRET_KEY =
  /(password|secret|token|jwt|authorization|apikey|api_key|dek|private|ciphertext|nonce|wrapped|cookie|signature|refresh)/i;
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Deep copy with secret-looking keys and JWT-looking strings replaced. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(JWT_LIKE, "[redacted-jwt]");
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && item !== null && item !== undefined && typeof item !== "boolean"
        ? "[redacted]"
        : redact(item),
    ]),
  );
}

function validate(name: string, expectations: string[]): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`recordOutcome name "${name}" must be kebab-case: <slug>-<NN>-<what>`);
  }
  if (!expectations || expectations.length === 0) {
    throw new Error(`recordOutcome("${name}") requires a non-empty expectations list.`);
  }
  if (expectations.length > 3) {
    throw new Error(
      `recordOutcome("${name}") allows at most 3 expectations (got ${expectations.length}). Split it into a second outcome.`,
    );
  }
}

export function recordOutcome(name: string, options: OutcomeOptions): string {
  validate(name, options.expectations);
  mkdirSync(GENERATED_DIR, { recursive: true });
  const path = join(GENERATED_DIR, `${name}.json`);
  const payload = {
    name,
    recordedAt: new Date().toISOString(),
    expectations: options.expectations,
    details: redact(options.details ?? {}),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

/** UI outcome: full-page PNG of the production Docusaurus page plus its JSON checklist. */
export async function captureOutcome(
  page: Page,
  name: string,
  options: OutcomeOptions,
): Promise<string> {
  validate(name, options.expectations);
  mkdirSync(GENERATED_DIR, { recursive: true });
  const png = join(GENERATED_DIR, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  recordOutcome(name, {
    ...options,
    details: { url: page.url(), screenshot: png, ...options.details },
  });
  return png;
}
