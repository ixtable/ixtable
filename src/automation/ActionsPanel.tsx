import { useId, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import type { DocumentConfig } from "../lib/types";
import { newId } from "../lib/utils";
import { browserContext } from "./context";
import { SelectField, TextField } from "./fields";
import { type ActionResult, runAction } from "./runner";
import { StepList } from "./StepEditor";
import { STEP_LABELS } from "./steps";
import type { ActionDef, OnError } from "./types";

const ON_ERROR: { value: OnError; label: string }[] = [
  { value: "stop", label: "Stop at the first failure" },
  { value: "continue", label: "Log failures and continue" },
  { value: "rollback", label: "Roll back all record changes" },
];

export function ActionsPanel({ focusId }: { focusId?: string }) {
  const { config, update } = useDocumentConfig();
  const actions = config.actions ?? [];
  const [selected, setSelected] = useState<string | null>(focusId ?? actions[0]?.id ?? null);
  const action = actions.find((a) => a.id === selected) ?? null;

  const edit = (mutate: (a: ActionDef) => ActionDef, label = "Edit action") =>
    update(
      (draft: DocumentConfig) => ({
        ...draft,
        actions: draft.actions.map((a) => (a.id === selected ? mutate(a) : a)),
      }),
      label,
    );
  const add = () => {
    const created: ActionDef = {
      id: newId(),
      name: `Action ${actions.length + 1}`,
      description: "",
      steps: [],
      onError: "stop",
    };
    setSelected(created.id);
    return update((draft) => ({ ...draft, actions: [...draft.actions, created] }), "Add action");
  };
  const remove = () => {
    const index = actions.findIndex((a) => a.id === selected);
    setSelected(actions[index + 1]?.id ?? actions[index - 1]?.id ?? null);
    return update(
      (draft) => ({ ...draft, actions: draft.actions.filter((a) => a.id !== selected) }),
      "Delete action",
    );
  };

  return (
    <div className="ax-split">
      <nav className="ax-list" aria-label="Actions">
        <button type="button" onClick={add}>
          New action
        </button>
        <ul>
          {actions.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                aria-current={a.id === selected ? "true" : undefined}
                onClick={() => setSelected(a.id)}
              >
                {a.name || "Untitled action"}
              </button>
            </li>
          ))}
        </ul>
        {!actions.length && <p>No actions yet.</p>}
      </nav>
      {action ? (
        <div className="ax-editor" aria-label={`Action ${action.name}`}>
          <div className="ax-row">
            <TextField
              label="Action name"
              value={action.name}
              onChange={(name) => edit((a) => ({ ...a, name }))}
            />
            <TextField
              label="Description"
              value={action.description}
              onChange={(description) => edit((a) => ({ ...a, description }))}
            />
            <SelectField
              label="On error"
              value={action.onError ?? "stop"}
              onChange={(onError) => edit((a) => ({ ...a, onError }))}
              options={ON_ERROR}
            />
            <button type="button" onClick={remove}>
              Delete action
            </button>
          </div>
          <StepList
            label="Step"
            actionId={action.id}
            steps={action.steps ?? []}
            onChange={(steps) => edit((a) => ({ ...a, steps }), "Edit action steps")}
          />
          <TestRun action={action} config={config} />
        </div>
      ) : (
        <div className="ax-editor">
          <p>Select or create an action.</p>
        </div>
      )}
    </div>
  );
}

function TestRun({ action, config }: { action: ActionDef; config: DocumentConfig }) {
  const id = useId();
  const [sample, setSample] = useState("{}");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [problem, setProblem] = useState("");
  const [running, setRunning] = useState(false);
  const run = async () => {
    let record: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(sample || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("The sample record must be a JSON object");
      record = parsed as Record<string, unknown>;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return;
    }
    setProblem("");
    setRunning(true);
    const log: string[] = [];
    const ctx = browserContext(
      config,
      (m, tone) => log.push(`${tone === "error" ? "Error" : "Message"}: ${m}`),
      {
        record,
        navigate: (t) => log.push(`Navigate to ${t.kind} ${t.id}${t.mode ? ` (${t.mode})` : ""}`),
        setState: (scope, key, value) => log.push(`Set ${scope}.${key} = ${JSON.stringify(value)}`),
      },
    );
    try {
      setResult(await runAction(action, ctx));
    } finally {
      setEvents(log);
      setRunning(false);
    }
  };
  return (
    <section className="ax-step" aria-label="Test run">
      <h2>Test run</h2>
      <p>Runs the action against the document's data. Record changes are real.</p>
      <div className="ax-field">
        <label htmlFor={id}>Sample record (JSON)</label>
        <textarea
          id={id}
          className="ax-code"
          rows={3}
          value={sample}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setSample(e.target.value)}
        />
        {problem && <small className="ax-problem">{problem}</small>}
      </div>
      <div>
        <button type="button" disabled={running} onClick={run}>
          Test run
        </button>
      </div>
      {result && (
        <div role="status" aria-label="Test run result">
          <p className={result.ok ? "ax-ok" : "ax-fail"}>
            {result.ok
              ? "Test run succeeded"
              : result.cancelled
                ? "Test run cancelled"
                : `Test run failed: ${result.error}`}
          </p>
          {!!events.length && (
            <ul>
              {events.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <StepLogTable steps={result.steps} />
        </div>
      )}
    </section>
  );
}

/** "2.then.0" → "3.then.1": step paths shown 1-based. */
const stepNumber = (path: string) =>
  path
    .split(".")
    .map((part) => (/^\d+$/.test(part) ? String(Number(part) + 1) : part))
    .join(".");

export function StepLogTable({ steps }: { steps: ActionResult["steps"] }) {
  if (!steps.length) return null;
  return (
    <table className="ax-log" aria-label="Step log">
      <thead>
        <tr>
          <th>Step</th>
          <th>Kind</th>
          <th>Result</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr key={i}>
            <td>{stepNumber(s.path ?? String(s.stepIndex))}</td>
            <td>{STEP_LABELS[s.kind] ?? s.kind}</td>
            <td className={s.ok ? "ax-ok" : "ax-fail"}>
              {s.skipped ? "Skipped" : s.ok ? "OK" : `Failed: ${s.error}`}
            </td>
            <td>{s.durationMs} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
