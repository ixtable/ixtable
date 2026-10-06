import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const load = vi.hoisted(() => ({ resolve: (_: unknown[]) => {} }));
vi.mock("../../src/templates/api", () => ({
  createFromTemplate: vi.fn(),
  listTemplates: () => new Promise((resolve) => (load.resolve = resolve)),
}));

const { TemplatePicker } = await import("../../src/shell/TemplatePicker");

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not update state when the template list arrives after unmount", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const view = render(<TemplatePicker disabled={false} run={vi.fn()} />);
    view.unmount();
    vi.stubGlobal("window", undefined);
    await act(async () => {
      load.resolve([{ id: "crm", name: "CRM", description: "", version: "1.0.0" }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.unstubAllGlobals();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
