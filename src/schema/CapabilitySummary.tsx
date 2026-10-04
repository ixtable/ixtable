import type { StoreCapabilities } from "./types";

const yesNo = (value: boolean) => (value ? "yes" : "no");

/** Read-only summary of the capability categories the type and DDL tables do not cover (PRD §9.4). */
export function CapabilitySummary({ capabilities: c }: { capabilities: StoreCapabilities }) {
  const rows: Array<[string, string]> = [
    ["Constraints", c.constraints.join(", ")],
    ["Relationship actions", c.foreignKeyActions.join(", ")],
    [
      "Indexes",
      `unique ${yesNo(c.indexes.unique)} · multi-column ${yesNo(c.indexes.multiColumn)} · partial ${yesNo(c.indexes.partial)} · expression ${yesNo(c.indexes.expression)}`,
    ],
    [
      "Transactions",
      `atomic batches ${yesNo(c.transactions.atomicBatches)} · transactional schema changes ${yesNo(c.transactions.transactionalDdl)} · savepoints ${yesNo(c.transactions.savepoints)} · isolation ${c.transactions.isolation}`,
    ],
    ["Parameter style", c.parameterStyle],
    ["Generated values", c.generatedValues.join(", ")],
    [
      "Migrations",
      [
        `transactional ${yesNo(c.migrations.transactionalDdl)}`,
        `dry run: ${c.migrations.dryRun}`,
        `health checks: ${c.migrations.healthChecks.join(", ") || "none"}`,
        c.migrations.notes,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    [
      "Concurrency",
      [
        `policies: ${c.concurrency.policies.join(", ")}`,
        `row locking ${yesNo(c.concurrency.rowLocking)}`,
        `multi user ${yesNo(c.concurrency.multiUser)}`,
        c.concurrency.notes,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
  ];
  return (
    <>
      <table aria-label="Store capabilities">
        <tbody>
          {rows.map(([name, detail]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table aria-label="Error codes">
        <thead>
          <tr>
            <th>Code</th>
            <th>Native error</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {c.errorCodes.map((e) => (
            <tr key={`${e.code}:${e.constraint ?? ""}:${e.native}`}>
              <td>
                {e.code}
                {e.constraint ? ` (${e.constraint})` : ""}
              </td>
              <td>{e.native}</td>
              <td>{e.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
