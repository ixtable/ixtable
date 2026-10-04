import { describe, expect, it } from "vitest";
import {
  CloudError,
  cloudErrorSummary,
  codeForStatus,
  fromBody,
  toCloudError,
} from "../../src/cloud/errors";

const response = (status: number, body: unknown) => ({
  status,
  clone() {
    return this;
  },
  json: async () => {
    if (typeof body === "string") throw new SyntaxError("not json");
    return body;
  },
});

describe("cloud error mapping", () => {
  it("maps the contract's {error:{code,message,details}} bodies", () => {
    const e = fromBody(409, {
      error: { code: "VERSION_CONFLICT", message: "Head moved", details: { headVersionId: "v2" } },
    });
    expect(e).toBeInstanceOf(CloudError);
    expect([e.code, e.message, e.status]).toEqual(["VERSION_CONFLICT", "Head moved", 409]);
    expect(e.details).toEqual({ headVersionId: "v2" });
    expect(fromBody(403, { error: { code: "REVOKED", message: "Access revoked" } }).code).toBe(
      "REVOKED",
    );
  });

  it("falls back to the HTTP status for unknown or hostile bodies", () => {
    expect(fromBody(401, null).code).toBe("UNAUTHENTICATED");
    expect(fromBody(402, { error: { code: "drop table; --" } }).code).toBe("ENTITLEMENT_REQUIRED");
    expect(fromBody(413, "<html>").code).toBe("TOO_LARGE");
    expect(fromBody(503, {}).code).toBe("CLOUD_UNAVAILABLE");
    expect(fromBody(400, { msg: "bad" }).message).toBe("bad");
    expect(fromBody(400, { error: "plain" }).message).toBe("plain");
    expect([401, 402, 403, 404, 409, 413, 422, 428, 429, 418].map(codeForStatus)).toEqual([
      "UNAUTHENTICATED",
      "ENTITLEMENT_REQUIRED",
      "FORBIDDEN",
      "NOT_FOUND",
      "VERSION_CONFLICT",
      "TOO_LARGE",
      "VALIDATION",
      "PENDING",
      "RATE_LIMITED",
      "CLOUD_ERROR",
    ]);
  });

  it("normalizes supabase-js Functions, Auth, PostgREST, Rust, and network errors", async () => {
    const http = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      name: "FunctionsHttpError",
      context: response(429, { error: { code: "RATE_LIMITED", message: "Slow down" } }),
    });
    expect(await toCloudError(http)).toMatchObject({ code: "RATE_LIMITED", message: "Slow down" });
    const html = Object.assign(new Error("x"), {
      name: "FunctionsHttpError",
      context: response(502, "<html>"),
    });
    expect((await toCloudError(html)).code).toBe("CLOUD_UNAVAILABLE");
    expect((await toCloudError({ name: "FunctionsFetchError", message: "Failed" })).code).toBe(
      "CLOUD_OFFLINE",
    );
    expect((await toCloudError(new TypeError("fetch failed"))).code).toBe("CLOUD_OFFLINE");
    expect((await toCloudError({ name: "FunctionsRelayError", message: "relay" })).code).toBe(
      "CLOUD_UNAVAILABLE",
    );
    expect(
      await toCloudError({
        name: "AuthApiError",
        message: "Invalid login credentials",
        status: 400,
      }),
    ).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid login credentials" });
    expect((await toCloudError({ name: "AuthRetryableFetchError", message: "x" })).code).toBe(
      "CLOUD_OFFLINE",
    );
    expect((await toCloudError({ code: "42501", message: "permission denied" })).code).toBe(
      "FORBIDDEN",
    );
    expect((await toCloudError({ code: "PGRST116", message: "no rows" })).code).toBe("CLOUD_ERROR");
    expect(
      await toCloudError({ name: "CommandError", code: "MANIFEST_SIGNATURE", message: "bad sig" }),
    ).toMatchObject({ code: "MANIFEST_SIGNATURE", message: "bad sig" });
    expect((await toCloudError("boom")).message).toBe("boom");
    const same = new CloudError("FORBIDDEN", "no");
    expect(await toCloudError(same)).toBe(same);
  });

  it("explains codes in plain language", () => {
    expect(cloudErrorSummary("REVOKED")).toMatch(/revoked/);
    expect(cloudErrorSummary("ARCHIVE_CHECKSUM")).toMatch(/discarded/);
    expect(cloudErrorSummary("SOMETHING_NEW")).toBe("The cloud operation failed.");
  });
});
