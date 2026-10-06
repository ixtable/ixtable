import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

let user: ReturnType<typeof userEvent.setup>;
import type { DocumentConfig, SessionState } from "../../src/lib/types";

let backend: DocumentConfig;
let configRevision = 0;
const write = async (config: DocumentConfig) => {
  backend = config;
  configRevision += 1;
  return {
    name: config.name,
    activeMode: config.activeMode,
    dirty: true,
    configRevision,
  } as SessionState;
};
const updateDocumentConfig = vi.fn(write);
const backendEdit = (change: Partial<DocumentConfig>) => {
  backend = { ...backend, ...change };
  configRevision += 1;
  return { name: backend.name, configRevision } as SessionState;
};
const readDocumentConfig = vi.fn(async () => structuredClone(backend));
vi.mock("../../src/lib/api", () => ({
  asTauriError: (error: unknown) => ({ code: "TEST", message: String(error) }),
  readDocumentConfig: () => readDocumentConfig(),
  updateDocumentConfig: (config: DocumentConfig) => updateDocumentConfig(config),
}));

const { DocumentConfigProvider, useDocumentConfig } = await import("../../src/lib/config-store");

function Probe() {
  const store = useDocumentConfig();
  const rename = (name: string, label = "Rename") =>
    store.update((draft) => ({ ...draft, name }), label);
  return (
    <div>
      <output aria-label="name">{store.config.name}</output>
      <output aria-label="mode">{store.config.activeMode}</output>
      <output aria-label="error">{store.error?.message}</output>
      <button onClick={() => rename("Alpha")}>Alpha</button>
      <button onClick={() => rename("Beta", "Other")}>Beta</button>
      <button
        onClick={() =>
          store.update((draft) => ({ ...draft, activeMode: "reports" }), "Mode", {
            undoable: false,
          })
        }
      >
        Mode
      </button>
      <button onClick={() => store.undo()} disabled={!store.canUndo}>
        Undo
      </button>
      <button onClick={() => store.redo()} disabled={!store.canRedo}>
        Redo
      </button>
      <input aria-label="field" />
      <button onClick={() => store.reload("Apply YAML")}>Reload</button>
      <button onClick={() => store.reload()}>Reload quietly</button>
      <button onClick={() => store.observe(backendEdit({ savedQueries: [{ id: "q1" }] } as never))}>
        Backend edit
      </button>
      <button onClick={() => store.observe(backendEdit({ savedQueries: [{ id: "q2" }] } as never))}>
        Second backend edit
      </button>
      <span>{store.undoLabel ?? "none"}</span>
    </div>
  );
}

async function renderStore() {
  const onState = vi.fn();
  render(
    <DocumentConfigProvider onState={onState} fallback={<p>Loading config</p>}>
      <Probe />
    </DocumentConfigProvider>,
  );
  await screen.findByText("Untitled");
  return { user, onState };
}

beforeEach(() => {
  user = userEvent.setup();
  backend = { name: "Untitled", activeMode: "data" } as DocumentConfig;
  configRevision = 0;
  updateDocumentConfig.mockClear();
  updateDocumentConfig.mockImplementation(write);
  readDocumentConfig.mockClear();
});

it("persists updates through update_document_config and reports session state", async () => {
  const { user, onState } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Alpha");
  await waitFor(() => expect(backend.name).toBe("Alpha"));
  expect(onState).toHaveBeenCalledWith(expect.objectContaining({ name: "Alpha" }));
});

it("undoes and redoes definition edits but keeps the active mode", async () => {
  const { user } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Beta" }));
  await user.click(screen.getByRole("button", { name: "Mode" }));
  expect(await screen.findByText("Other")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Untitled");
  expect(screen.getByRole("status", { name: "mode" })).toHaveTextContent("reports");
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Redo" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Beta");
  await waitFor(() => expect(backend).toMatchObject({ name: "Beta", activeMode: "reports" }));
});

it("coalesces rapid edits with the same label into one undo step", async () => {
  const { user } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await user.click(screen.getByRole("button", { name: "Beta" }));
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Alpha");
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Untitled");
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("handles Ctrl+Z and Ctrl+Shift+Z outside text fields only", async () => {
  const { user } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await user.click(screen.getByRole("textbox", { name: "field" }));
  await user.keyboard("{Control>}z{/Control}");
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Alpha");
  await user.click(screen.getByRole("button", { name: "Beta" }));
  await user.keyboard("{Control>}z{/Control}");
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Alpha");
  await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Beta");
});

it("records an external change as an undo step when reloading with a label", async () => {
  const { user } = await renderStore();
  backend = { ...backend, name: "From YAML" };
  await user.click(screen.getByRole("button", { name: "Reload" }));
  expect(await screen.findByText("From YAML")).toBeInTheDocument();
  expect(await screen.findByText("Apply YAML")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(backend.name).toBe("Untitled"));
});

it("reloads backend-owned changes without an undo step and keeps them on undo", async () => {
  const { user } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await waitFor(() => expect(backend.name).toBe("Alpha"));
  backend = { ...backend, entities: [{ id: "e1", table: "orders" }] } as unknown as DocumentConfig;
  await user.click(screen.getByRole("button", { name: "Reload quietly" }));
  await waitFor(() => expect(readDocumentConfig).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Rename")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Untitled");
  await waitFor(() => expect(backend.name).toBe("Untitled"));
  expect(backend.entities).toEqual([{ id: "e1", table: "orders" }]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("reloads before editing when a session state shows a newer config revision", async () => {
  const { user } = await renderStore();
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await waitFor(() => expect(backend.name).toBe("Alpha"));
  expect(readDocumentConfig).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Backend edit" }));
  await user.click(screen.getByRole("button", { name: "Beta" }));
  await waitFor(() => expect(backend.name).toBe("Beta"));
  expect(readDocumentConfig).toHaveBeenCalledTimes(2);
  expect(backend.savedQueries).toEqual([{ id: "q1" }]);
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  await waitFor(() => expect(backend.name).toBe("Alpha"));
  expect(readDocumentConfig).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Second backend edit" }));
  await user.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(readDocumentConfig).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(backend.name).toBe("Beta"));
  expect(backend.savedQueries).toEqual([{ id: "q2" }]);
});

function Capture({ into }: { into: (store: ReturnType<typeof useDocumentConfig>) => void }) {
  into(useDocumentConfig());
  return null;
}

async function renderCapture() {
  let store!: ReturnType<typeof useDocumentConfig>;
  const onState = vi.fn();
  render(
    <DocumentConfigProvider onState={onState} fallback={<p>Loading config</p>}>
      <Capture into={(value) => (store = value)} />
      <Probe />
    </DocumentConfigProvider>,
  );
  await screen.findByText("Untitled");
  return { store: () => store, onState };
}

function start<T>(run: () => T): T {
  let out!: T;
  act(() => {
    out = run();
  });
  return out;
}

function slowWrites() {
  const gates: Array<() => void> = [];
  updateDocumentConfig.mockImplementation(async (config: DocumentConfig) => {
    const reply = config.name.startsWith("Bad")
      ? Promise.reject(new Error(`invalid ${config.name}`))
      : write(config);
    reply.catch(() => undefined);
    await new Promise<void>((resolve) => gates.push(resolve));
    return reply;
  });
  return {
    release: async () => {
      await waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()?.();
    },
  };
}

const settle = <T,>(promise: Promise<T>) =>
  promise.then(
    () => "ok",
    (reason: Error) => reason.message,
  );
const queries = (id: string) => (draft: DocumentConfig) =>
  ({ ...draft, savedQueries: [{ id }] }) as unknown as DocumentConfig;
const named = (name: string) => (draft: DocumentConfig) => ({ ...draft, name });

it("coalesces rapid updates into the in-flight write plus one write of the latest config", async () => {
  const writes = slowWrites();
  const { store, onState } = await renderCapture();
  const names = Array.from({ length: 10 }, (_, i) => `I${i}`);
  const done = start(() =>
    names.map((name) => store().update((draft) => ({ ...draft, name }), "Rename report")),
  );
  expect(updateDocumentConfig).toHaveBeenCalledTimes(1);
  let flushed = false;
  void store()
    .settled()
    .then(() => (flushed = true));
  await act(writes.release);
  await act(writes.release);
  const states = await Promise.all(done);
  expect(updateDocumentConfig).toHaveBeenCalledTimes(2);
  expect(updateDocumentConfig.mock.calls.map(([config]) => config.name)).toEqual(["I0", "I9"]);
  expect(backend.name).toBe("I9");
  expect(states[0]).toMatchObject({ name: "I0", configRevision: 1 });
  expect(states.slice(1).every((state) => state.name === "I9")).toBe(true);
  expect(onState.mock.calls.map(([state]) => state.name)).toEqual(["I0", "I9"]);
  await waitFor(() => expect(flushed).toBe(true));
  expect(await screen.findByText("Rename report")).toBeInTheDocument();
});

it("persists a valid update coalesced with an invalid one and rejects only the invalid one", async () => {
  const writes = slowWrites();
  const { store } = await renderCapture();
  const results = start(() =>
    [named("A"), queries("b"), named("Bad C")].map((mutator) => settle(store().update(mutator))),
  );
  for (let i = 0; i < 4; i += 1) await act(writes.release);
  expect(await Promise.all(results)).toEqual(["ok", "ok", "invalid Bad C"]);
  expect(updateDocumentConfig.mock.calls.map(([config]) => config.name)).toEqual([
    "A",
    "Bad C",
    "A",
    "Bad C",
  ]);
  expect(backend).toMatchObject({ name: "A", savedQueries: [{ id: "b" }] });
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("A");
  expect(screen.getByRole("status", { name: "error" })).toHaveTextContent("invalid Bad C");
  const retry = start(() => store().update(named("D")));
  await act(writes.release);
  await expect(retry).resolves.toMatchObject({ name: "D" });
  expect(backend.name).toBe("D");
  expect(screen.getByRole("status", { name: "error" })).toBeEmptyDOMElement();
});

it("clears the error when the pending write succeeds after the in-flight one fails", async () => {
  const writes = slowWrites();
  const { store } = await renderCapture();
  const results = start(() => [named("Bad A"), queries("b")].map((m) => settle(store().update(m))));
  await act(writes.release);
  await act(writes.release);
  expect(await Promise.all(results)).toEqual(["invalid Bad A", "ok"]);
  expect(updateDocumentConfig.mock.calls[1][0].name).toBe("Untitled");
  expect(backend).toMatchObject({ name: "Untitled", savedQueries: [{ id: "b" }] });
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("Untitled");
  expect(screen.getByRole("status", { name: "error" })).toBeEmptyDOMElement();
});

it("keeps an update made while reload reads the config", async () => {
  const { store } = await renderCapture();
  let release!: () => void;
  readDocumentConfig.mockImplementationOnce(async () => {
    const snapshot = structuredClone(backend);
    await new Promise<void>((resolve) => (release = resolve));
    return snapshot;
  });
  const reloaded = start(() => store().reload());
  await waitFor(() => expect(readDocumentConfig).toHaveBeenCalledTimes(2));
  await act(() => store().update(named("During")));
  expect(backend.name).toBe("During");
  await act(async () => release());
  await expect(reloaded).resolves.toMatchObject({ name: "During" });
  expect(readDocumentConfig).toHaveBeenCalledTimes(3);
  await act(() => store().update(queries("q")));
  expect(backend).toMatchObject({ name: "During", savedQueries: [{ id: "q" }] });
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("During");
});

it("does not overwrite a backend change made while a write was in flight", async () => {
  const writes = slowWrites();
  const { store } = await renderCapture();
  const results = start(() => [named("A"), named("B")].map((m) => settle(store().update(m))));
  act(() => store().observe(backendEdit({ savedQueries: [{ id: "q1" }] } as never)));
  await act(writes.release);
  await act(writes.release);
  expect(await Promise.all(results)).toEqual(["ok", "ok"]);
  expect(readDocumentConfig).toHaveBeenCalledTimes(2);
  expect(backend).toMatchObject({ name: "B", savedQueries: [{ id: "q1" }] });
  expect(screen.getByRole("status", { name: "name" })).toHaveTextContent("B");
});

it("keeps writing after onState throws", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { store, onState } = await renderCapture();
  onState.mockImplementationOnce(() => {
    throw new Error("listener failed");
  });
  await act(async () => {
    await expect(store().update(named("A"))).resolves.toMatchObject({ name: "A" });
    await expect(store().update(named("B"))).resolves.toMatchObject({ name: "B" });
  });
  await expect(store().settled()).resolves.toBeUndefined();
  expect(backend.name).toBe("B");
  expect(logged).toHaveBeenCalledWith(new Error("listener failed"));
});

it("waits for queued writes before reloading", async () => {
  const writes = slowWrites();
  const { store } = await renderCapture();
  const reloaded = start(() => {
    void store().update(named("A"));
    void store().update(named("B"));
    return store().reload();
  });
  await act(writes.release);
  await act(writes.release);
  await expect(reloaded).resolves.toMatchObject({ name: "B" });
  expect(readDocumentConfig).toHaveBeenCalledTimes(2);
});
