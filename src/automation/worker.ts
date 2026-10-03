/**
 * Background job worker: claims due jobs for the open document, runs each job's
 * action with a headless context, and reports the outcome to the queue. It runs
 * only while the app is open (PRD §17.3); jobs left running by a crash are
 * requeued by jobs.rs when their lease expires.
 */
import type { DocumentConfig } from "../lib/types";
import { claimNextJob, completeJob, failJob, JOBS_CHANGED_EVENT } from "./api";
import { type ActionContext, runAction } from "./runner";
import type { JobPayload } from "./triggers";
import type { Job } from "./types";

export interface WorkerEnv {
  getConfig(): DocumentConfig;
  app?(): Record<string, unknown>;
  /** Called after each finished job (e.g. to refresh data views). */
  onJob?(job: Job, ok: boolean): void;
}

/** A context without a user: navigation, confirmation and form state fail clearly. */
export function headlessContext(
  config: DocumentConfig,
  payload: Partial<JobPayload>,
  app: Record<string, unknown>,
  messages: { text: string; tone: string }[],
): ActionContext {
  const unavailable = (what: string) => () => {
    throw new Error(`${what} is not available in background jobs`);
  };
  return {
    config,
    record: payload.record ?? undefined,
    old: payload.old ?? undefined,
    app,
    triggerDepth: payload.triggerDepth ?? 1,
    navigate: unavailable("Navigation"),
    confirm: async () => unavailable("Confirmation")(),
    setState: (scope) => {
      if (scope === "form") unavailable("Form state")();
    },
    notify: (text, tone = "info") => {
      messages.push({ text, tone });
    },
  };
}

/** Claims and runs one job. Resolves with the job, or null when none is due. */
export async function runNextJob(env: WorkerEnv): Promise<Job | null> {
  const job = await claimNextJob();
  if (!job) return null;
  const messages: { text: string; tone: string }[] = [];
  let ok = false;
  try {
    const config = env.getConfig();
    const action = config.actions.find((a) => a.id === job.actionId);
    if (!action) throw new Error(`Action ${job.actionId} does not exist`);
    const ctx = headlessContext(
      config,
      (job.payload ?? {}) as Partial<JobPayload>,
      env.app?.() ?? {},
      messages,
    );
    const result = await runAction(action, ctx);
    const log = { steps: result.steps, messages };
    ok = result.ok;
    if (result.ok) await completeJob(job.id, log);
    else await failJob(job.id, result.error ?? "Action failed", log);
  } catch (error) {
    // A cancelled job refuses its result (INVALID_STATE); anything else is a failed attempt.
    const message = error instanceof Error ? error.message : String(error);
    if (!/is cancelled/.test(message))
      await failJob(job.id, message, { messages }).catch(() => undefined);
  }
  env.onJob?.(job, ok);
  return job;
}

/**
 * Starts the worker; returns a stop function. It always wakes on JOBS_CHANGED_EVENT;
 * with an interval it also polls (for retries whose backoff has elapsed).
 */
export function startWorker(
  env: WorkerEnv,
  { intervalMs = 1000 as number | null } = {},
): () => void {
  let stopped = false;
  let busy = false;
  let again = false;
  const tick = async () => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        while (!stopped && (await runNextJob(env))) {
          // keep draining due jobs
        }
      } while (again && !stopped);
    } catch {
      // No document, or the queue is unavailable: try again on the next tick.
    } finally {
      busy = false;
    }
  };
  const wake = () => {
    tick().catch(() => undefined);
  };
  const timer = intervalMs ? setInterval(wake, intervalMs) : undefined;
  window.addEventListener(JOBS_CHANGED_EVENT, wake);
  if (intervalMs) wake();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    window.removeEventListener(JOBS_CHANGED_EVENT, wake);
  };
}
