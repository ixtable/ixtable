// Tiny request-body validators. Each throws 422 VALIDATION naming the field.
// Usage: const body = await readJson(req); const appId = uuid(body, "appId");
import { HttpError } from "./http.ts";

type Body = Record<string, unknown>;
interface Opt {
  optional?: boolean;
}

function fail(field: string, message: string): never {
  throw new HttpError("VALIDATION", `${field}: ${message}`, { field });
}

function missing(body: Body, key: string): boolean {
  return body[key] === undefined || body[key] === null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function obj(value: unknown, field = "body"): Body {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(field, "must be an object");
  return value as Body;
}

export function str(
  body: Body,
  key: string,
  o: Opt & { optional: true; min?: number; max?: number; pattern?: RegExp },
): string | undefined;
export function str(
  body: Body,
  key: string,
  o?: Opt & { min?: number; max?: number; pattern?: RegExp },
): string;
export function str(
  body: Body,
  key: string,
  o: Opt & { min?: number; max?: number; pattern?: RegExp } = {},
): string | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  const value = body[key];
  if (typeof value !== "string") fail(key, "must be a string");
  if (value.length < (o.min ?? 1)) fail(key, `must be at least ${o.min ?? 1} characters`);
  if (value.length > (o.max ?? 10_000)) fail(key, `must be at most ${o.max ?? 10_000} characters`);
  if (o.pattern && !o.pattern.test(value)) fail(key, "has an invalid format");
  return value;
}

export function uuid(body: Body, key: string, o: { optional: true }): string | undefined;
export function uuid(body: Body, key: string, o?: Opt): string;
export function uuid(body: Body, key: string, o: Opt = {}): string | undefined {
  const value = o.optional
    ? str(body, key, { optional: true, max: 36 })
    : str(body, key, { max: 36 });
  if (value === undefined) return undefined;
  if (!UUID_RE.test(value)) fail(key, "must be a UUID");
  return value.toLowerCase();
}

export function int(
  body: Body,
  key: string,
  o: Opt & { optional: true; min?: number; max?: number },
): number | undefined;
export function int(body: Body, key: string, o?: Opt & { min?: number; max?: number }): number;
export function int(
  body: Body,
  key: string,
  o: Opt & { min?: number; max?: number } = {},
): number | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(key, "must be an integer");
  if (o.min !== undefined && value < o.min) fail(key, `must be at least ${o.min}`);
  if (o.max !== undefined && value > o.max) fail(key, `must be at most ${o.max}`);
  return value;
}

export function bool(body: Body, key: string, o: { optional: true }): boolean | undefined;
export function bool(body: Body, key: string, o?: Opt): boolean;
export function bool(body: Body, key: string, o: Opt = {}): boolean | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  if (typeof body[key] !== "boolean") fail(key, "must be true or false");
  return body[key] as boolean;
}

export function oneOf<T extends string>(
  body: Body,
  key: string,
  values: readonly T[],
  o: { optional: true },
): T | undefined;
export function oneOf<T extends string>(body: Body, key: string, values: readonly T[], o?: Opt): T;
export function oneOf<T extends string>(
  body: Body,
  key: string,
  values: readonly T[],
  o: Opt = {},
): T | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  const value = body[key];
  if (typeof value !== "string" || !values.includes(value as T))
    fail(key, `must be one of ${values.join(", ")}`);
  return value as T;
}

export function arr(
  body: Body,
  key: string,
  o: Opt & { optional: true; max?: number },
): unknown[] | undefined;
export function arr(body: Body, key: string, o?: Opt & { max?: number }): unknown[];
export function arr(
  body: Body,
  key: string,
  o: Opt & { max?: number } = {},
): unknown[] | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  const value = body[key];
  if (!Array.isArray(value)) fail(key, "must be an array");
  if (value.length > (o.max ?? 1000)) fail(key, `must have at most ${o.max ?? 1000} items`);
  return value;
}

export function record(body: Body, key: string, o: { optional: true }): Body | undefined;
export function record(body: Body, key: string, o?: Opt): Body;
export function record(body: Body, key: string, o: Opt = {}): Body | undefined {
  if (missing(body, key)) return o.optional ? undefined : fail(key, "is required");
  return obj(body[key], key);
}

export function sha256(body: Body, key: string): string {
  const value = str(body, key, { min: 64, max: 64 }).toLowerCase();
  if (!SHA256_RE.test(value)) fail(key, "must be a hex SHA-256");
  return value;
}

export function semver(body: Body, key: string): string {
  return str(body, key, { max: 100, pattern: SEMVER_RE });
}

export function email(body: Body, key: string): string {
  const value = str(body, key, { max: 320 }).trim().toLowerCase();
  if (!EMAIL_RE.test(value)) fail(key, "must be an email address");
  return value;
}
