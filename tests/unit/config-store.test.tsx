import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

let user: ReturnType<typeof userEvent.setup>;
import type { DocumentConfig, SessionState } from "../../src/lib/types";

let backend: DocumentConfig;
const updateDocumentConfig = vi.fn(async (config: DocumentConfig) => {
  backend = config;
  return { name: config.name, activeMode: config.activeMode, dirty: true } as SessionState;
});
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
  updateDocumentConfig.mockClear();
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
