/** Error codes of the ixtable Cloud contract plus client-side codes. */
export type CloudErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "TOO_LARGE"
  | "ENTITLEMENT_REQUIRED"
  | "RATE_LIMITED"
  | "VALIDATION"
  | "REVOKED"
  | "PENDING"
  | "CLOUD_OFFLINE"
  | "CLOUD_UNAVAILABLE"
  | "CLOUD_NOT_CONFIGURED"
  | "CLOUD_ERROR"
  | (string & {});

/** A failed cloud operation with a stable code (from the server, the client, or Rust). */
export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: CloudErrorCode,
    message: string,
    status?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const statusCodes: Record<number, CloudErrorCode> = {
  401: "UNAUTHENTICATED",
  402: "ENTITLEMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "VERSION_CONFLICT",
  413: "TOO_LARGE",
  422: "VALIDATION",
  428: "PENDING",
  429: "RATE_LIMITED",
};

/** Stable code for an HTTP status without a structured body. */
export const codeForStatus = (status: number): CloudErrorCode =>
  statusCodes[status] ?? (status >= 500 ? "CLOUD_UNAVAILABLE" : "CLOUD_ERROR");

const isCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z_]{1,63}$/.test(value);

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; details?: unknown } | string;
  code?: unknown;
  message?: unknown;
  msg?: unknown;
};

/** Maps a response body (`{error:{code,message}}` or anything else) and status to a CloudError. */
export function fromBody(status: number, body: unknown): CloudError {
  const parsed = (body && typeof body === "object" ? body : {}) as ErrorBody;
  const inner = typeof parsed.error === "object" && parsed.error ? parsed.error : parsed;
  const code = isCode(inner.code) ? inner.code : codeForStatus(status);
  const message =
    typeof inner.message === "string"
      ? inner.message
      : typeof parsed.msg === "string"
        ? parsed.msg
        : typeof parsed.error === "string"
          ? parsed.error
          : `ixtable Cloud answered with HTTP ${status}`;
  const details =
    "details" in inner && inner.details && typeof inner.details === "object"
      ? (inner.details as Record<string, unknown>)
      : undefined;
  return new CloudError(code, message, status, details);
}

type ResponseLike = {
  status: number;
  clone?: () => ResponseLike;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};
const isResponse = (value: unknown): value is ResponseLike =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ResponseLike).status === "number" &&
  typeof (value as ResponseLike).json === "function";

/**
 * Normalizes anything a cloud call can throw: supabase-js Functions errors
 * (HTTP with a Response in `context`, fetch, relay), PostgREST errors, Auth
 * errors, Rust `CommandError`s, and network `TypeError`s.
 */
export async function toCloudError(error: unknown): Promise<CloudError> {
  if (error instanceof CloudError) return error;
  if (!error || typeof error !== "object")
    return new CloudError("CLOUD_ERROR", String(error ?? "Unknown error"));
  const e = error as {
    name?: string;
    code?: unknown;
    message?: string;
    status?: number;
    context?: unknown;
  };
  if (e.name === "FunctionsHttpError" && isResponse(e.context)) {
    const response = e.context;
    let body: unknown;
    try {
      body = await (response.clone ? response.clone() : response).json();
    } catch {
      body = null;
    }
    return fromBody(response.status, body);
  }
  if (
    e.name === "FunctionsFetchError" ||
    (e.name === "TypeError" && /fetch/i.test(e.message ?? ""))
  )
    return new CloudError(
      "CLOUD_OFFLINE",
      "ixtable Cloud is not reachable. Check your connection.",
    );
  if (e.name === "FunctionsRelayError")
    return new CloudError("CLOUD_UNAVAILABLE", e.message ?? "ixtable Cloud is unavailable");
  if (
    e.name === "AuthApiError" ||
    e.name === "AuthRetryableFetchError" ||
    e.name?.startsWith("Auth")
  ) {
    if (e.name === "AuthRetryableFetchError")
      return new CloudError(
        "CLOUD_OFFLINE",
        "ixtable Cloud is not reachable. Check your connection.",
      );
    return new CloudError(
      e.status === 429 ? "RATE_LIMITED" : "UNAUTHENTICATED",
      e.message ?? "Sign-in failed",
      e.status,
    );
  }
  // PostgREST: { code: "42501" | "PGRST301", message, details, hint }.
  if (typeof e.code === "string" && /^PGRST\d+$|^(?=.*\d)[0-9A-Z]{5}$/.test(e.code)) {
    const code: CloudErrorCode =
      e.code === "42501" || e.code === "PGRST301" ? "FORBIDDEN" : "CLOUD_ERROR";
    return new CloudError(code, e.message ?? "The cloud query failed");
  }
  if (isCode(e.code)) return new CloudError(e.code, e.message ?? e.code, e.status);
  return new CloudError("CLOUD_ERROR", e.message ?? "The cloud operation failed");
}

const friendly: Record<string, string> = {
  UNAUTHENTICATED: "Your cloud session ended. Sign in again.",
  FORBIDDEN: "Your account is not allowed to do this.",
  REVOKED: "Your access to this application was revoked by its developer.",
  NOT_FOUND: "The cloud application or version was not found.",
  VERSION_CONFLICT: "Someone published a newer checkpoint since this document last synced.",
  TOO_LARGE: "The archive is larger than the 500 MB cloud limit.",
  ENTITLEMENT_REQUIRED: "This application's plan does not allow this. The developer must upgrade.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  VALIDATION: "ixtable Cloud rejected the request.",
  CLOUD_OFFLINE: "ixtable Cloud is not reachable. Check your connection.",
  CLOUD_UNAVAILABLE: "ixtable Cloud is temporarily unavailable.",
  CLOUD_NOT_CONFIGURED: "ixtable Cloud is not configured in this build.",
  MANIFEST_SIGNATURE:
    "The application bundle is not signed by ixtable Cloud. It was not installed.",
  MANIFEST_EXPIRED: "The download authorization expired. Sync again.",
  MANIFEST_MISMATCH: "The bundle was issued for someone else. It was not installed.",
  ARCHIVE_CHECKSUM: "The download was corrupted or modified. It was discarded.",
  CLOUD_KEY_MISSING: "This build cannot verify cloud bundles (no signing key).",
  SAVE_REQUIRED: "Save the document first.",
  NOT_INSTALLED: "Connect to ixtable Cloud once to install this application.",
  UPDATE_FAILED: "The update failed and was rolled back. The previous version is still in use.",
};

/** Plain-language summary for a cloud error code. */
export const cloudErrorSummary = (code: string) => friendly[code] ?? "The cloud operation failed.";
