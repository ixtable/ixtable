import { expect, it } from "vitest";
import { newForm } from "../../src/design/schema";
import { sourceParams } from "../../src/runtime/data";

const scope = { app: { user: { name: "Ana" } }, params: { bin: "B" } };

it("evaluates query source bindings over app and page params", () => {
  const form = {
    ...newForm("Q", { kind: "query", queryId: "q" }),
    source: {
      kind: "query" as const,
      queryId: "q",
      params: { bin: "params.bin", who: "app.user.name", blank: " " },
    },
  };
  expect(sourceParams(form, scope)).toEqual({ bin: "B", who: "Ana" });
});

it("ignores table sources and names the failing parameter", () => {
  expect(sourceParams(newForm("T", { kind: "table", table: "t" }), scope)).toEqual({});
  const broken = {
    ...newForm("Q"),
    source: { kind: "query" as const, queryId: "q", params: { bin: "params.bin +" } },
  };
  expect(() => sourceParams(broken, scope)).toThrow(/^Parameter \$bin:/);
});
