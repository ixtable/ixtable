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
  | "EXPIRED"
  | "ALREADY_USED"
  | "ALLOWANCE_EXCEEDED"
  | "PENDING"
  | "NETWORK"
  | "INTERNAL"
  | "UNKNOWN";

const FRIENDLY: Record<CloudErrorCode, string> = {
  UNAUTHENTICATED: "Your session has expired. Sign in again to continue.",
  FORBIDDEN: "You do not have permission to do this.",
  NOT_FOUND: "This item does not exist or you do not have access to it.",
  VERSION_CONFLICT:
    "Someone published a newer version first. Review the versions list and choose overwrite or fork.",
  TOO_LARGE: "The archive is larger than the 500 MB limit.",
  ENTITLEMENT_REQUIRED:
    "This app needs an active plan with enough runtime users. The app owner must upgrade the plan.",
  RATE_LIMITED: "Too many requests. Wait a minute and try again.",
  VALIDATION: "Some of the values are not valid.",
  REVOKED: "Access was revoked by the app owner.",
  EXPIRED: "This link has expired. Ask the sender for a new one.",
  ALREADY_USED: "This link was already used.",
  ALLOWANCE_EXCEEDED:
    "This app has reached its runtime user allowance. The app owner must upgrade the plan before you can join.",
  PENDING: "Waiting for approval.",
  NETWORK: "ixtable Cloud could not be reached. Check your connection and try again.",
  INTERNAL: "ixtable Cloud had an internal error. Try again, or contact support if it continues.",
  UNKNOWN: "Something went wrong. Try again.",
};

export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status: number | null;
  readonly detail: string | null;
  /** Structured `error.details` from the function, e.g. `{ reason: "over_allowance" }`. */
  readonly details: Record<string, unknown>;

  constructor(
    code: CloudErrorCode,
    detail: string | null = null,
    status: number | null = null,
    details: Record<string, unknown> = {},
  ) {
    super(friendlyMessage(code, detail));
    this.name = "CloudError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.details = details;
  }
}

const STATUS_CODES: Record<number, CloudErrorCode> = {
  401: "UNAUTHENTICATED",
  402: "ENTITLEMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "VERSION_CONFLICT",
  410: "EXPIRED",
  413: "TOO_LARGE",
  422: "VALIDATION",
  428: "PENDING",
  429: "RATE_LIMITED",
  500: "INTERNAL",
};

export function friendlyMessage(code: CloudErrorCode, detail: string | null = null): string {
  // VALIDATION and FORBIDDEN details come from the server and name the exact field or rule.
  if ((code === "VALIDATION" || code === "FORBIDDEN") && detail) return detail;
  return FRIENDLY[code];
}

function isKnownCode(value: unknown): value is CloudErrorCode {
  return typeof value === "string" && value in FRIENDLY;
}

/** Builds a CloudError from an Edge Function error body `{ error: { code, message } }`. */
export function fromErrorBody(body: unknown, status: number | null): CloudError {
  const error =
    body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
  if (error && typeof error === "object") {
    const { code, message, details } = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const detail = typeof message === "string" ? message : null;
    const extra =
      details && typeof details === "object" ? (details as Record<string, unknown>) : {};
    if (isKnownCode(code)) return new CloudError(code, detail, status, extra);
    if (status && STATUS_CODES[status])
      return new CloudError(STATUS_CODES[status], detail, status, extra);
    return new CloudError("UNKNOWN", detail, status, extra);
  }
  if (status && STATUS_CODES[status]) return new CloudError(STATUS_CODES[status], null, status);
  return new CloudError("UNKNOWN", null, status);
}

/** Maps a PostgREST error (RLS denial, missing row) to a CloudError. */
export function fromPostgrestError(error: { code?: string; message?: string }): CloudError {
  if (error.code === "42501") return new CloudError("FORBIDDEN", null, 403);
  if (error.code === "PGRST116") return new CloudError("NOT_FOUND", null, 404);
  if (error.code === "PGRST301" || error.code === "PGRST303")
    return new CloudError("UNAUTHENTICATED", null, 401);
  return new CloudError("UNKNOWN", error.message ?? null, null);
}

export function toCloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  if (error instanceof TypeError) return new CloudError("NETWORK", error.message);
  return new CloudError("UNKNOWN", error instanceof Error ? error.message : null);
}
