/**
 * Golden-app journeys (PRD §26.5): helpers shared by the golden suites, plus a
 * structured evidence recorder. Every journey writes
 * `tests/integration/golden/.evidence/<app>-<journey>.json` with its steps,
 * assertions, timings, and (on failure) the error, the steps that reproduce it, and
 * the tail of the local diagnostic log.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { expect } from "vitest";
import App from "../../../src/App";
import type { DataValue } from "../helpers";

export const LONG = { timeout: 20_000 };
export type User = ReturnType<typeof userEvent.setup>;

const EVIDENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".evidence");

type Assertion = { description: string; expected: unknown; actual: unknown; passed: boolean };
type Step = {
  name: string;
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  assertions: Assertion[];
  error?: string;
};

/** Large values (whole configs, tables) are recorded as a digest so evidence stays small. */
function summarize(value: unknown): unknown {
  const json = JSON.stringify(value) ?? "null";
  if (json.length <= 2000) return value;
  return { sha256: createHash("sha256").update(json).digest("hex"), bytes: json.length };
}

/** Records one journey's steps and assertions and writes them as JSON evidence. */
export class Journey {
  private steps: Step[] = [];
  private current: Step | null = null;
  private readonly started = Date.now();

  constructor(
    readonly app: string,
    readonly name: string,
  ) {}

  /** Runs one named user step; failures are recorded before they propagate. */
  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const step: Step = {
      name,
      status: "passed",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      assertions: [],
    };
    this.steps.push(step);
    this.current = step;
    const t0 = performance.now();
    try {
      return await run();
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      step.durationMs = Math.round(performance.now() - t0);
      this.current = null;
    }
  }

  /** Deep-equality assertion that is also written to the evidence. */
  check(description: string, actual: unknown, expected: unknown) {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    (this.current ?? this.steps.at(-1))?.assertions.push({
      description,
      expected: summarize(expected),
      actual: summarize(actual),
      passed,
    });
    expect(actual, description).toEqual(expected);
  }

  /** Writes the evidence file; call from `finally` so failures leave evidence too. */
  write(error?: unknown, logTail?: unknown[]) {
    const failed = this.steps.find((s) => s.status === "failed");
    const evidence = {
      app: this.app,
      journey: this.name,
      status: error || failed ? "failed" : "passed",
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      steps: this.steps,
      ...(error || failed
        ? {
            error: failed?.error ?? (error instanceof Error ? error.message : String(error)),
            reproduction: this.steps
              .slice(0, failed ? this.steps.indexOf(failed) + 1 : undefined)
              .map((s, i) => `${i + 1}. ${s.name}`),
            ...(logTail ? { logTail } : {}),
          }
        : {}),
    };
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      join(EVIDENCE_DIR, `${this.app}-${this.name}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
}

/** The newest local diagnostic log entries, or undefined when they cannot be read. */
export async function readLogTail(limit = 100): Promise<unknown[] | undefined> {
  try {
    return await invoke<unknown[]>("read_logs", { windowLabel: "main", limit });
  } catch {
    return undefined;
  }
}

/** Runs a journey and always writes its evidence. */
export async function withJourney(
  app: string,
  name: string,
  run: (journey: Journey) => Promise<void>,
) {
  const journey = new Journey(app, name);
  try {
    await run(journey);
    journey.write();
  } catch (error) {
    journey.write(error, await readLogTail());
    throw error;
  }
}

/** Opens the start screen and creates the document from a template through the UI. */
export async function startFromTemplate(name: string): Promise<User> {
  const user = userEvent.setup();
  render(<App />);
  const section = await screen.findByRole("region", { name: "Start from a template" }, LONG);
  await user.click(
    await within(section).findByRole("button", { name: `Create ${name} from template` }, LONG),
  );
  await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  return user;
}

export type Issue = { severity: string; objectKind: string; objectId: string; message: string };
export const validateDocument = () => invoke<Issue[]>("validate_document", { windowLabel: "main" });
export const errorsOf = (issues: Issue[]) =>
  issues
    .filter((i) => i.severity === "error")
    .map((i) => `${i.objectKind} ${i.objectId}: ${i.message}`);

type QueryResult = { columns: string[]; rows: DataValue[][] };
type Named = { id: string; name: string };
type Definitions = { savedQueries: Named[]; triggers: Named[]; migrations: Named[] };
/** The open document's definitions (ids are UUIDv7; tests find objects by name). */
export const definitions = () =>
  invoke<Definitions>("read_document_config", { windowLabel: "main" });

/** Id of the definition named `name` in one of the config's lists. */
export async function idOf(list: keyof Definitions, name: string) {
  const found = (await definitions())[list].find((o) => o.name === name);
  if (!found) throw new Error(`No ${list} entry named ${name}`);
  return found.id;
}

/** Runs a saved query (by name) through the public Queries command and returns plain rows. */
export async function savedQuery(name: string, params: Record<string, unknown> = {}) {
  const result = await invoke<QueryResult>("run_saved_query", {
    windowLabel: "main",
    id: await idOf("savedQueries", name),
    params: Object.entries(params).map(([column, value]) => ({
      column,
      value: toValue(value),
    })),
    limit: null,
    runId: null,
  });
  return result.rows.map((row) => row.map(plain));
}

const toValue = (value: unknown): DataValue =>
  value === null || value === undefined
    ? { type: "null" }
    : typeof value === "number"
      ? Number.isInteger(value)
        ? { type: "integer", value }
        : { type: "real", value }
      : { type: "text", value: String(value) };

const plain = (cell: DataValue) => (cell.type === "null" ? null : (cell.value ?? null));

/** Plain rows of a read-only SQL query through DuckDB. */
export async function sql(text: string) {
  const result = await invoke<QueryResult>("execute_read_query", {
    windowLabel: "main",
    sql: text,
  });
  return result.rows.map((row) => row.map(plain));
}
export const scalar = async (text: string) => (await sql(text))[0]?.[0];

export const runtimeNav = () => screen.getByRole("navigation", { name: "Application navigation" });
export const runtimePage = () => screen.getByRole("region", { name: "Application page" });

/** Clicks a Runtime navigation entry (groups are expanded by default). */
export async function openPage(user: User, label: string) {
  await user.click(within(runtimeNav()).getByRole("button", { name: label }));
}

/** Opens a navigation entry's list; choosing the entry that is already open returns to its list too. */
export const showList = openPage;

/** Picks a relationship option once the lookup has loaded it. */
export async function chooseRelated(user: User, form: HTMLElement, label: string, option: string) {
  const select = await within(form).findByRole("combobox", { name: label }, LONG);
  await within(select).findByRole("option", { name: option }, LONG);
  await user.selectOptions(select, option);
}

/** Waits for an alert in `container` with this text (earlier alerts may still be showing). */
export async function expectAlert(container: HTMLElement, text: string | RegExp) {
  await waitFor(() => {
    const alerts = within(container).queryAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join("\n")).toMatch(text);
  }, LONG);
}

/** Waits until a saved query or SQL condition holds (writes land through the bridge). */
export async function eventually(assertion: () => Promise<void>) {
  await waitFor(assertion, LONG);
}
