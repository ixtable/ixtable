import { useCallback, useEffect, useState } from "react";
import { asTauriError } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { StepLogTable } from "./ActionsPanel";
import {
  cancelJob,
  JOBS_CHANGED_EVENT,
  jobAttempts,
  listJobs,
  notifyJobsChanged,
  retryJob,
} from "./api";
import { SelectField } from "./fields";
import type { Job, JobAttempt, JobStatus, StepLog } from "./types";

const STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

export function JobsPanel({ refreshMs = 2000 }: { refreshMs?: number }) {
  const { config } = useDocumentConfig();
  const [status, setStatus] = useState<JobStatus | "">("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      setJobs(await listJobs({ status: status || null }));
      setError("");
    } catch (reason) {
      setError(asTauriError(reason).message);
    }
  }, [status]);
  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), refreshMs);
    const wake = () => {
      setTimeout(() => load().catch(() => undefined), 0);
    };
    window.addEventListener(JOBS_CHANGED_EVENT, wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener(JOBS_CHANGED_EVENT, wake);
    };
  }, [load, refreshMs, revision]);

  const act = async (run: () => Promise<Job>) => {
    try {
      await run();
      notifyJobsChanged();
      await load();
    } catch (reason) {
      setError(asTauriError(reason).message);
    }
  };
  const triggerName = (id: string) => config.triggers.find((t) => t.id === id)?.name ?? id;
  const actionName = (id: string) => config.actions.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="ax-editor">
      <div className="ax-row">
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          none="All statuses"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <button type="button" onClick={() => setRevision((r) => r + 1)}>
          Refresh jobs
        </button>
      </div>
      <p>
        The job queue runs only while ixtable is open. Jobs left running when it closed are retried.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!jobs.length ? (
        <p>No jobs.</p>
      ) : (
        <table className="ax-log" aria-label="Jobs">
          <thead>
            <tr>
              <th>Trigger</th>
              <th>Action</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Next run</th>
              <th>Last error</th>
              <th>
                <span className="sr-only">Commands</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                trigger={triggerName(job.triggerId)}
                action={actionName(job.actionId)}
                expanded={open === job.id}
                onToggle={() => setOpen(open === job.id ? null : job.id)}
                onCancel={() => act(() => cancelJob(job.id))}
                onRetry={() => act(() => retryJob(job.id))}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function JobRow({
  job,
  trigger,
  action,
  expanded,
  onToggle,
  onCancel,
  onRetry,
}: {
  job: Job;
  trigger: string;
  action: string;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const name = `${trigger} job ${job.id.slice(0, 8)}`;
  return (
    <>
      <tr aria-label={name}>
        <td>{trigger}</td>
        <td>{action}</td>
        <td className={`ax-status-${job.status}`}>{job.status}</td>
        <td>
          {job.attempts} / {job.maxAttempts}
        </td>
        <td>{job.status === "queued" ? new Date(job.nextRunAt).toLocaleTimeString() : ""}</td>
        <td>{job.lastError ?? ""}</td>
        <td>
          <div className="ax-step-tools">
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`History of ${name}`}
              onClick={onToggle}
            >
              History
            </button>
            {(job.status === "queued" || job.status === "running") && (
              <button type="button" aria-label={`Cancel ${name}`} onClick={onCancel}>
                Cancel
              </button>
            )}
            {(job.status === "failed" || job.status === "cancelled") && (
              <button type="button" aria-label={`Retry ${name}`} onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            <Attempts jobId={job.id} revision={`${job.updatedAt}`} />
          </td>
        </tr>
      )}
    </>
  );
}

function Attempts({ jobId, revision }: { jobId: string; revision: string }) {
  const [attempts, setAttempts] = useState<JobAttempt[] | null>(null);
  useEffect(() => {
    let live = true;
    jobAttempts(jobId)
      .then((list) => live && setAttempts(list))
      .catch(() => live && setAttempts([]));
    return () => {
      live = false;
    };
  }, [jobId, revision]);
  if (!attempts) return <p>Loading attempts…</p>;
  if (!attempts.length) return <p>No attempts yet.</p>;
  return (
    <ol aria-label="Attempts">
      {attempts.map((a) => {
        const steps = (a.log as { steps?: StepLog[] } | null)?.steps ?? [];
        return (
          <li key={a.attempt}>
            Attempt {a.attempt}:{" "}
            {a.ok === null || a.ok === undefined
              ? "running"
              : a.ok
                ? "succeeded"
                : `failed — ${a.error}`}{" "}
            <small>({new Date(a.startedAt).toLocaleString()})</small>
            <StepLogTable steps={steps} />
          </li>
        );
      })}
    </ol>
  );
}
