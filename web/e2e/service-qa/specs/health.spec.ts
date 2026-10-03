import { expect, test } from "@playwright/test";
import { callFunction, functionsUrl } from "../clients";
import { recordOutcome } from "../record";

test("health reports database, storage and version without auth", async () => {
  const result = await callFunction<{
    ok: boolean;
    db: boolean;
    storage: boolean;
    version: string;
  }>("health", {
    method: "GET",
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true, db: true, storage: true, version: expect.any(String) });
  expect(result.headers.get("cache-control")).toBe("no-store");

  recordOutcome("health-01-ok", {
    expectations: [
      "GET functions/v1/health without a user JWT returns 200 with ok, db and storage all true.",
      "The response names the deployed version and is not cacheable.",
    ],
    details: { status: result.status, body: result.body },
  });
});

// The local Kong gateway rewrites Access-Control-Allow-Origin to "*" on
// functions/v1, so the origin allow-list itself is covered by the Deno unit
// tests (supabase/functions/_shared/http_test.ts). Here: the function's own
// CORS headers reach the client and errors follow the contract.
test("health sends the shared CORS headers and uses the error contract", async () => {
  const response = await fetch(functionsUrl("health"), {
    headers: { Origin: "tauri://localhost" },
  });
  const allowHeaders = response.headers.get("access-control-allow-headers") ?? "";
  const allowOrigin = response.headers.get("access-control-allow-origin");
  expect(response.status).toBe(200);
  for (const header of ["authorization", "apikey", "content-type", "stripe-signature"]) {
    expect(allowHeaders).toContain(header);
  }
  expect(allowOrigin === "tauri://localhost" || allowOrigin === "*").toBe(true);

  const wrongMethod = await callFunction("health", { method: "PUT", body: {} });
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.body).toEqual({
    error: { code: "METHOD_NOT_ALLOWED", message: expect.any(String) },
  });

  recordOutcome("health-02-cors-and-errors", {
    expectations: [
      "A request from tauri://localhost gets the shared CORS headers (authorization, apikey, content-type, stripe-signature allowed).",
      "An unsupported method returns 405 with {error:{code:'METHOD_NOT_ALLOWED',message}}.",
    ],
    details: {
      allowHeaders,
      allowOrigin,
      wrongMethod: { status: wrongMethod.status, body: wrongMethod.body },
    },
  });
});
