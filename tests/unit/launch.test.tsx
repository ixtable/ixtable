import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OPEN_FILES_EVENT } from "../../src/lib/launch";
import { useOpenRequests } from "../../src/shell/openRequests";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => (command === "take_launch_files" ? ["/docs/first.ixt"] : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

function Probe() {
  const { request, handled } = useOpenRequests();
  return (
    <button type="button" onClick={() => request && handled(request.id)}>
      {request?.path ?? "none"}
    </button>
  );
}

it("opens the launch file first, then each forwarded file, and clears a handled request", async () => {
  const { unmount } = render(<Probe />);
  const button = await screen.findByRole("button", { name: "/docs/first.ixt" });
  act(() => handlers.get(OPEN_FILES_EVENT)?.({ payload: ["/docs/second.ixtr", "/docs/x.ixt"] }));
  expect(button).toHaveTextContent("/docs/second.ixtr");
  act(() => button.click());
  expect(button).toHaveTextContent("none");
  unmount();
  expect(handlers.has(OPEN_FILES_EVENT)).toBe(false);
});
