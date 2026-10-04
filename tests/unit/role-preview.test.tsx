import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentConfig } from "../../src/lib/types";

const preview = vi.hoisted(() => vi.fn());
vi.mock("../../src/runtime/api", () => ({
  setRuntimeRolePreview: (roleId: string | null) => preview(roleId),
}));

const { useRolePreviewResync, useRuntimeState } = await import("../../src/runtime/navigation");
const { activeRoleId } = await import("../../src/runtime/rbac");

const config = {
  roles: [{ id: "clerk", name: "Clerk", permissions: { navigation: [], objects: [], actions: [] } }],
  design: { forms: [], navigation: [] },
} as unknown as DocumentConfig;

beforeEach(() => preview.mockReset());

it("shows a refused role preview and falls back to developer access", async () => {
  preview.mockImplementation(async (roleId: string | null) => {
    if (roleId) throw { code: "IO_ERROR", message: "session busy" };
  });
  const { result } = renderHook(() => useRuntimeState(config));
  act(() => result.current.setRoleId("clerk"));
  await waitFor(() => expect(result.current.notice?.tone).toBe("error"));
  expect(result.current.notice?.message).toContain("session busy");
  expect(result.current.roleId).toBeNull();
  await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null));
});

it("clears a leftover Rust preview outside Run mode and reports failures", async () => {
  const report = vi.fn();
  preview.mockRejectedValueOnce({ code: "IO_ERROR", message: "no session" });
  const { rerender } = renderHook(({ run }) => useRolePreviewResync("s1", run, report), {
    initialProps: { run: false },
  });
  await waitFor(() => expect(report).toHaveBeenCalledWith(expect.stringContaining("no session")));
  expect(preview).toHaveBeenCalledWith(null);
  expect(activeRoleId()).toBeNull();
  preview.mockClear();
  rerender({ run: true });
  expect(preview).not.toHaveBeenCalled();
  preview.mockResolvedValue(undefined);
  preview.mockRejectedValueOnce({ code: "FORBIDDEN", message: "cloud" });
  rerender({ run: false });
  await waitFor(() => expect(preview).toHaveBeenCalledWith(null));
  expect(report).toHaveBeenCalledTimes(1);
});
