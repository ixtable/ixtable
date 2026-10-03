import { call } from "../lib/api";
import type { Issue } from "../lib/types";
import type { Job, JobAttempt, JobStatus } from "./types";

export interface EnqueueJobRequest {
  triggerId: string;
  actionId: string;
  payload: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
  backoffMs?: number;
}

/** Adds a job to the durable queue; the same idempotency key returns the existing job. */
export const enqueueJob = (job: EnqueueJobRequest) => call<Job>("enqueue_job", { job });
export const claimNextJob = (leaseMs?: number) =>
  call<Job | null>("claim_next_job", { leaseMs: leaseMs ?? null });
export const completeJob = (id: string, log: unknown) => call<Job>("complete_job", { id, log });
export const failJob = (id: string, error: string, log: unknown) =>
  call<Job>("fail_job", { id, error, log });
export const cancelJob = (id: string) => call<Job>("cancel_job", { id });
export const retryJob = (id: string) => call<Job>("retry_job", { id });
export const listJobs = (filter: { status?: JobStatus | null; limit?: number } = {}) =>
  call<Job[]>("list_jobs", {
    filter: { status: filter.status ?? null, limit: filter.limit ?? null },
  });
export const jobAttempts = (id: string) => call<JobAttempt[]>("job_attempts", { id });
/** Automation issues including checks against the database's tables. */
export const validateAutomation = () => call<Issue[]>("validate_automation");

/** Window event that wakes the background job worker (e.g. right after an enqueue). */
export const JOBS_CHANGED_EVENT = "ixtable:jobs-changed";
export const notifyJobsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
};
