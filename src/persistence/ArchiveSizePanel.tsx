import { useCallback, useEffect, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { archiveSizeReport } from "./api";
import { formatBytes, formatPercent } from "./format";
import type { ArchiveSizeReport } from "./types";

const SECTIONS = [
  ["recordsBytes", "Records"],
  ["configBytes", "Configuration"],
  ["assetsBytes", "Assets"],
  ["otherBytes", "Other"],
] as const;

/** Archive size by section, largest entries, and the 500 MB cloud limit (PRD §7.4). */
export function ArchiveSizePanel({ revision }: { revision: number }) {
  const [report, setReport] = useState<ArchiveSizeReport | null>(null);
  const [error, setError] = useState<TauriError | null>(null);
  const [busy, setBusy] = useState(false);
  const measure = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await archiveSizeReport());
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    measure().catch(() => undefined);
  }, [measure, revision]);

  return (
    <section className="settings-section" aria-labelledby="archive-size">
      <h3 id="archive-size">Archive size</h3>
      <div className="settings-actions">
        <button disabled={busy} onClick={() => measure()}>
          Measure archive size
        </button>
        {busy && <span>Measuring…</span>}
      </div>
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{error.message}</span>
        </div>
      )}
      {report && <ArchiveSizeDetails report={report} />}
    </section>
  );
}

/** Totals, cloud-limit verdict, sections, and largest entries of one size report. */
export function ArchiveSizeDetails({ report }: { report: ArchiveSizeReport }) {
  return (
    <>
      <p>
        {formatBytes(report.totalBytes)} in total; assets take {formatPercent(report.assetShare)}.{" "}
        {report.measured === "saved"
          ? "Measured on the saved archive."
          : "Measured on a snapshot that includes unsaved changes."}
      </p>
      {report.overCloudLimit ? (
        <div className="error" role="alert">
          <b>Over the cloud limit</b>
          <span>
            This archive is larger than {formatBytes(report.cloudLimitBytes)}. It keeps working
            locally but cannot sync to ixtable Cloud until it is smaller.
          </span>
        </div>
      ) : (
        <p>Within the {formatBytes(report.cloudLimitBytes)} cloud limit.</p>
      )}
      <dl className="size-breakdown" aria-label="Archive size by section">
        {SECTIONS.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{formatBytes(report[key])}</dd>
          </div>
        ))}
      </dl>
      <h4>Largest entries</h4>
      <ol className="size-largest" aria-label="Largest archive entries">
        {report.largest.map((entry) => (
          <li key={`${entry.section}-${entry.id}`}>
            <span>{entry.name}</span>
            <small>{entry.section}</small>
            <b>{formatBytes(entry.bytes)}</b>
          </li>
        ))}
      </ol>
    </>
  );
}
