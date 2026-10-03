import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

let user: ReturnType<typeof userEvent.setup>;
import type { DocumentConfig, SessionState } from "../../src/lib/types";

let backend: DocumentConfig;
let configRevision = 0;
const updateDocumentConfig = vi.fn(async (config: DocumentConfig) => {
  backend = config;
  configRevision += 1;
  return {
    name: config.name,
    activeMode: config.activeMode,
    dirty: true,
    configRevision,
  } as SessionState;
});
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
