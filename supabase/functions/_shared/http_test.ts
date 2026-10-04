import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { corsHeaders, handler, HttpError, readJson } from "./http.ts";
import { redactSecrets } from "./audit.ts";

const post = (body: string, origin?: string) =>
  new Request("http://localhost/fn", {
    method: "POST",
    body,
    headers: origin ? { origin } : {},
  });

Deno.test("handler maps return values, HttpError and unknown errors to the contract", async () => {
  const ok = await handler(() => ({ hello: "world" }))(post("{}"));
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { hello: "world" });

  const conflict = await handler(() => {
    throw new HttpError("VERSION_CONFLICT", "head moved", { headVersionId: "x" });
  })(post("{}"));
  assertEquals(conflict.status, 409);
  assertEquals(await conflict.json(), {
    error: { code: "VERSION_CONFLICT", message: "head moved", details: { headVersionId: "x" } },
  });

  const boom = await handler(() => {
    throw new Error("db password is hunter2");
  })(post("{}"));
  assertEquals(boom.status, 500);
  assertEquals(await boom.json(), { error: { code: "INTERNAL", message: "Internal error" } });

  const wrongMethod = await handler(() => ({}))(new Request("http://localhost/fn"));
  assertEquals(wrongMethod.status, 405);
});

Deno.test("CORS echoes only allowed origins and answers preflight", async () => {
  assertEquals(
    corsHeaders(post("{}", "tauri://localhost"))["Access-Control-Allow-Origin"],
    "tauri://localhost",
  );
  assertEquals(
    corsHeaders(post("{}", "http://127.0.0.1:3001"))["Access-Control-Allow-Origin"],
    "http://127.0.0.1:3001",
  );
  assertEquals(
    corsHeaders(post("{}", "https://evil.example"))["Access-Control-Allow-Origin"],
    undefined,
  );
  const preflight = await handler(() => ({}))(
    new Request("http://localhost/fn", {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost" },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-origin"), "http://tauri.localhost");
});

Deno.test("readJson accepts objects and rejects other bodies", async () => {
  assertEquals(await readJson(post('{"a":1}')), { a: 1 });
  assertEquals(await readJson(post("")), {});
  await assertRejects(() => readJson(post("[1]")), HttpError);
  await assertRejects(() => readJson(post("{nope")), HttpError);
  await assertRejects(() => readJson(post(`"${"x".repeat(1_100_000)}"`)), HttpError);
});

Deno.test("redactSecrets hides secret-looking keys at any depth", () => {
  assertEquals(redactSecrets({ appId: "a", dek: "k", nested: [{ refreshToken: "t", ok: 1 }] }), {
    appId: "a",
    dek: "[redacted]",
    nested: [{ refreshToken: "[redacted]", ok: 1 }],
  });
  assert(true);
});
