import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionState } from "../../src/lib/types";
import { AutosaveController, type AutosaveView } from "../../src/persistence/autosave";

const session = (patch: Partial<SessionState> = {}): SessionState => ({
  sessionId: "s",
  documentId: "d",
  name: "Doc",
  path: "/tmp/doc.ixt",
  workspace: "/tmp/w",
  dirty: false,
  conflict: false,
  saving: false,
  activeMode: "data",
  attachmentCount: 0,
  autosaveEligible: true,
  lastSavedAt: null,
  lastError: null,
  ...patch,
});

let views: AutosaveView[];
const statuses = () => views.map((view) => view.status);

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
});
afterEach(() => vi.useRealTimers());

function controller(save: () => Promise<SessionState>) {
  const onState = vi.fn();
  const auto = new AutosaveController({
    save,
    onState,
    onChange: (view) => views.push(view),
    debounceMs: 1500,
    maxWaitMs: 10_000,
  });
  return { auto, onState };
}

it("debounces bursts of changes into one save after the quiet period", async () => {
  const save = vi.fn(async () => session({ lastSavedAt: "2026-10-03T10:00:00Z" }));
  const { auto, onState } = controller(save);
  auto.sync(session({ dirty: true }));
  await vi.advanceTimersByTimeAsync(1000);
  auto.touch();
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).not.toHaveBeenCalled();
  expect(auto.state.status).toBe("dirty");
  await vi.advanceTimersByTimeAsync(600);
  expect(save).toHaveBeenCalledOnce();
  expect(onState).toHaveBeenCalledOnce();
  expect(auto.state).toMatchObject({ status: "saved", lastSavedAt: "2026-10-03T10:00:00Z" });
  expect(statuses()).toContain("saving");
});

it("saves within the max wait even while edits keep arriving", async () => {
  const save = vi.fn(async () => session({ lastSavedAt: "t" }));
  const { auto } = controller(save);
  auto.sync(session({ dirty: true }));
  for (let elapsed = 0; elapsed < 10_000; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(1000);
    if (!save.mock.calls.length) auto.touch();
  }
  expect(save).toHaveBeenCalledOnce();
});

it("does not autosave untitled or conflicted documents", async () => {
  const save = vi.fn(async () => session());
  const { auto } = controller(save);
  auto.sync(session({ dirty: true, path: null }));
  auto.touch();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(save).not.toHaveBeenCalled();
  expect(auto.state).toMatchObject({ status: "dirty", eligible: false });
  auto.sync(
    session({
      dirty: true,
      conflict: true,
      lastError: { code: "EXTERNAL_CONFLICT", message: "x" },
    }),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  expect(save).not.toHaveBeenCalled();
  await expect(auto.flush()).resolves.toBeNull();
});

it("shows save errors and retries on flush", async () => {
  const save = vi
    .fn<() => Promise<SessionState>>()
    .mockRejectedValueOnce({ code: "IO_ERROR", message: "disk full" })
    .mockResolvedValueOnce(session({ lastSavedAt: "later" }));
  const { auto } = controller(save);
  auto.sync(session({ dirty: true }));
  await vi.advanceTimersByTimeAsync(1500);
  expect(auto.state).toMatchObject({
    status: "error",
    error: { code: "IO_ERROR", message: "disk full" },
  });
  auto.touch();
  expect(auto.state.status).toBe("error");
  await auto.flush();
  expect(auto.state).toMatchObject({ status: "saved", error: null, lastSavedAt: "later" });
});

it("runs one save at a time and saves again for edits made during a save", async () => {
  let release: (state: SessionState) => void = () => undefined;
  const save = vi
    .fn<() => Promise<SessionState>>()
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValue(session({ lastSavedAt: "second" }));
  const { auto } = controller(save);
  auto.sync(session({ dirty: true }));
  await vi.advanceTimersByTimeAsync(1500);
  expect(auto.state.status).toBe("saving");
  const again = auto.flush();
  auto.sync(session({ dirty: true }));
  release(session({ lastSavedAt: "first" }));
  await again;
  expect(save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1500);
  expect(save).toHaveBeenCalledTimes(2);
  expect(auto.state).toMatchObject({ status: "saved", lastSavedAt: "second" });
});

it("adopts manual saves and backend errors from synced states", () => {
  const { auto } = controller(vi.fn());
  auto.sync(session());
  expect(auto.state.status).toBe("clean");
  auto.sync(session({ lastSavedAt: "now" }));
  expect(auto.state).toMatchObject({ status: "saved", lastSavedAt: "now" });
  auto.sync(session({ lastError: { code: "IO_ERROR", message: "boom" } }));
  expect(auto.state.status).toBe("error");
  auto.dispose();
  auto.touch();
  expect(auto.state.status).toBe("error");
});
