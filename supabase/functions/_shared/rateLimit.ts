// Abuse controls and service counters (PRD Phase 5).
import { serviceClient } from "./db.ts";
import { HttpError } from "./http.ts";

/** True while `bucket` has had at most `max` hits in the current window. */
export async function rateLimit(
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("rate_limit", {
    p_bucket: bucket,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(`rate_limit failed: ${error.message}`);
  return data === true;
}

/** Throws 429 RATE_LIMITED when the bucket is exhausted. Bucket e.g. `key-grant:${userId}`. */
export async function enforceRateLimit(
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  if (!(await rateLimit(bucket, max, windowSeconds))) {
    throw new HttpError("RATE_LIMITED", "Too many requests. Try again later.", {
      retryAfterSeconds: windowSeconds,
    });
  }
}

/** Best-effort daily counter in service_metrics (never throws). */
export async function incrementMetric(name: string, by = 1): Promise<void> {
  try {
    await serviceClient().rpc("metric_increment", { p_name: name, p_by: by });
  } catch {
    // Metrics must never fail a request.
  }
}
