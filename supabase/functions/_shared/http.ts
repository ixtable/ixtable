// HTTP plumbing shared by every ixtable Cloud Edge Function: JSON responses,
// the error contract from docs/decisions/cloud-architecture.md, CORS, and
// caller authentication.
import type { User } from "./db.ts";
import { serviceClient } from "./db.ts";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "VERSION_CONFLICT"
  | "TOO_LARGE"
  | "ENTITLEMENT_REQUIRED"
  | "PENDING"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "REVOKED"
  | "INTERNAL";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  ENTITLEMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  REVOKED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  VERSION_CONFLICT: 409,
  TOO_LARGE: 413,
  VALIDATION: 422,
  PENDING: 428,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Throw this from a handler; `handler()` turns it into `{error:{code,message}}`. */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:3001",
  "http://localhost:3001",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

/** Allowed browser origins: defaults + SITE_URL + comma-separated CORS_ALLOWED_ORIGINS. */
export function allowedOrigins(): string[] {
  const extra = (Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const site = Deno.env.get("SITE_URL");
  return [...DEFAULT_ORIGINS, ...(site ? [new URL(site).origin] : []), ...extra];
}

export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, stripe-signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  const origin = req.headers.get("origin");
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function json(
  req: Request,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/** `{error:{code,message}}` for HttpError; INTERNAL (no detail leaked) otherwise. */
export function errorResponse(req: Request, err: unknown): Response {
  if (err instanceof HttpError) {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details) error.details = err.details;
    return json(req, { error }, err.status);
  }
  console.error("unhandled error", err instanceof Error ? err.message : String(err));
  return json(req, { error: { code: "INTERNAL", message: "Internal error" } }, 500);
}

/** Answers CORS preflight; returns null for any other method. */
export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

const MAX_JSON_BYTES = 1_048_576;

/** Parses a JSON object body (≤1 MiB). Throws VALIDATION / TOO_LARGE. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new HttpError("TOO_LARGE", "Request body is too large");
  }
  if (text.trim() === "") return {} as T;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError("VALIDATION", "Request body must be JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("VALIDATION", "Request body must be a JSON object");
  }
  return value as T;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface AuthedUser {
  user: User;
  /** The caller's access token, for a user-scoped client (`userClient(jwt)`). */
  jwt: string;
}

/** Resolves the signed-in caller from `Authorization: Bearer <jwt>`. Throws UNAUTHENTICATED. */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const jwt = bearerToken(req);
  if (!jwt) throw new HttpError("UNAUTHENTICATED", "Sign in required");
  const { data, error } = await serviceClient().auth.getUser(jwt);
  if (error || !data.user) throw new HttpError("UNAUTHENTICATED", "Session is invalid or expired");
  return { user: data.user, jwt };
}

export type Handler = (req: Request) => Promise<Response | unknown> | Response | unknown;

/**
 * Wraps a function body: answers OPTIONS, enforces the method list, turns a
 * plain return value into a 200 JSON response and thrown errors into the
 * error contract. Usage: `Deno.serve(handler(async (req) => ({ ok: true })))`.
 */
export function handler(
  fn: Handler,
  options: { methods?: string[] } = {},
): (req: Request) => Promise<Response> {
  const methods = options.methods ?? ["POST"];
  return async (req: Request) => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (!methods.includes(req.method)) {
        throw new HttpError("METHOD_NOT_ALLOWED", `Use ${methods.join(" or ")}`);
      }
      const result = await fn(req);
      return result instanceof Response ? result : json(req, result ?? {});
    } catch (err) {
      return errorResponse(req, err);
    }
  };
}
