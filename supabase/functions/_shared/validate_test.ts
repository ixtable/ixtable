import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { HttpError } from "./http.ts";
import { arr, bool, email, int, oneOf, semver, sha256, str, uuid } from "./validate.ts";

const body = {
  name: "CRM",
  appId: "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B",
  size: 10,
  on: true,
  kind: "version",
  hash: "A".repeat(64),
  version: "1.2.3-beta.1",
  mail: " Person@Example.com ",
  list: [1, 2],
};

Deno.test("validators return typed, normalized values", () => {
  assertEquals(str(body, "name", { max: 10 }), "CRM");
  assertEquals(uuid(body, "appId"), "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
  assertEquals(int(body, "size", { min: 1, max: 10 }), 10);
  assertEquals(bool(body, "on"), true);
  assertEquals(oneOf(body, "kind", ["version", "backup"] as const), "version");
  assertEquals(sha256(body, "hash"), "a".repeat(64));
  assertEquals(semver(body, "version"), "1.2.3-beta.1");
  assertEquals(email(body, "mail"), "person@example.com");
  assertEquals(arr(body, "list", { max: 2 }), [1, 2]);
  assertEquals(str(body, "missing", { optional: true }), undefined);
  assertEquals(uuid(body, "missing", { optional: true }), undefined);
});

Deno.test("validators throw VALIDATION naming the field", () => {
  const error = assertThrows(() => uuid({ appId: "nope" }, "appId"), HttpError);
  assertEquals([error.code, error.status, error.details], ["VALIDATION", 422, { field: "appId" }]);
  assertThrows(() => str({}, "name"), HttpError);
  assertThrows(() => int({ size: 1.5 }, "size"), HttpError);
  assertThrows(() => int({ size: 11 }, "size", { max: 10 }), HttpError);
  assertThrows(() => oneOf({ kind: "x" }, "kind", ["a"]), HttpError);
  assertThrows(() => semver({ version: "1.2" }, "version"), HttpError);
  assertThrows(() => arr({ list: [1, 2, 3] }, "list", { max: 2 }), HttpError);
  assertThrows(() => bool({ on: "yes" }, "on"), HttpError);
});
