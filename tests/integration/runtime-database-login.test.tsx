import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import App from "../../src/App";
import { readPage, renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
const windowLabel = "main";
const state = process.env.IXTABLE_STATE_DIR!;
const postgresUrl = process.env.IXTABLE_TEST_POSTGRES_URL;
type Json = Record<string, unknown>;

async function usePostgres(datasource: Json, password: string | null) {
  let passwordRef: string | null = null;
  if (password)
    passwordRef = await invoke<string>("set_datasource_password", {
      windowLabel,
      datasourceId: datasource.id,
      password,
      datasource,
    });
  const config = await invoke<Json>("read_document_config", { windowLabel });
  await invoke("update_document_config", {
    windowLabel,
    config: { ...config, datasource: { ...datasource, passwordRef } },
  });
  return passwordRef;
}

async function openBundle(bundle: string) {
  await invoke("close_document", { windowLabel, force: true });
  const user = userEvent.setup();
  render(<App />);
  dialogMock.open.mockResolvedValueOnce(bundle);
  await user.click(await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG));
  const bar = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
  return { user, bar };
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

it("asks for a database login when a shared bundle carries none and stores nothing it cannot verify", async () => {
  await invoke("new_document", { windowLabel });
  const datasource = {
    kind: "postgres",
    id: `pg-login-${Date.now()}`,
    host: "127.0.0.1",
    port: 1,
    database: "orders",
    user: "app_reader",
    sslmode: "require",
    credentialMode: "shared",
  };
  await usePostgres(datasource, null);
  const bundle = join(state, "pg-login.ixtr");
  await invoke("export_runtime_bundle", {
    windowLabel,
    path: bundle,
    options: { version: "1.0.0", releaseNotes: "" },
  });
  const { user, bar } = await openBundle(bundle);

  const dialog = await screen.findByRole("dialog", { name: "Database login" }, LONG);
  expect(dialog).toHaveTextContent("“orders” on 127.0.0.1");
  expect(within(dialog).getByRole("textbox", { name: "Database user" })).toHaveValue("app_reader");
  expect(dialog).toHaveTextContent("Connection security: sslmode require.");
  expect(within(dialog).getByRole("note")).toHaveTextContent(/does not verify the database server/);
  await user.type(within(dialog).getByLabelText("Database password"), "typed-secret-1");
  const connect = within(dialog).getByRole("button", { name: "Connect" });
  expect(connect).toBeDisabled();
  await expect(
    invoke("set_runtime_datasource_login", {
      windowLabel,
      user: "app_reader",
      password: "typed-secret-1",
    }).then(
      () => "sent",
      (e: unknown) => String((e as Error).message ?? e),
    ),
  ).resolves.toMatch(/UNVERIFIED_TRANSPORT/);
  await user.click(within(dialog).getByRole("checkbox", { name: /I accept sending my password/ }));
  expect(connect).toBeEnabled();
  await user.click(connect);
  expect(await within(dialog).findByRole("alert", {}, LONG)).toHaveTextContent(/Could not connect/);
  expect(within(dialog).getByLabelText("Database password")).toHaveValue("");
  expect(within(dialog).queryByRole("button", { name: "Forget saved login" })).toBeNull();
  const status = await invoke<Json>("runtime_datasource_login_status", { windowLabel });
  expect(status).toMatchObject({
    applies: true,
    source: "none",
    needsLogin: true,
    reason: "missing",
    sslmode: "require",
    serverVerified: false,
  });
  expect(JSON.stringify(status)).not.toContain("typed-secret-1");

  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Database login" })).toBeNull();
  await user.click(within(bar).getByRole("button", { name: "Database login…" }));
  await screen.findByRole("dialog", { name: "Database login" }, LONG);
  cleanup();
  await invoke("close_document", { windowLabel, force: true });
  for (const file of files(join(state, "data")))
    expect(readFileSync(file).includes("typed-secret-1"), file).toBe(false);
}, 120_000);

it("does not offer a database login for a SQLite bundle or in Studio", async () => {
  await renderNewDocument();
  await expect(
    invoke<Json>("runtime_datasource_login_status", { windowLabel }),
  ).resolves.toMatchObject({ applies: false });
  await expect(
    invoke("set_runtime_datasource_login", { windowLabel, user: "x", password: "y" }).then(
      () => "stored",
      (e: unknown) => String((e as Error).message ?? e),
    ),
  ).resolves.toMatch(/NOT_RUNTIME/);
});

it.skipIf(!postgresUrl)(
  "verifies, stores per installation, and forgets a recipient's PostgreSQL login",
  async () => {
    const url = new URL(postgresUrl!);
    const login = decodeURIComponent(url.username);
    const secret = decodeURIComponent(url.password);
    const table = `ixt_login_${Date.now()}`;
    await invoke("new_document", { windowLabel });
    const datasource = {
      kind: "postgres",
      id: `pg-real-${Date.now()}`,
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      user: login,
      sslmode: "disable",
      insecureTransportConfirmed: true,
      insecureTransportConfirmedAt: new Date().toISOString(),
      credentialMode: "shared",
    };
    const passwordRef = await usePostgres(datasource, secret);
    await invoke("create_database_table", {
      windowLabel,
      spec: {
        name: table,
        columns: [{ name: "id", logicalType: "integer", nullable: false, primaryKeyPosition: 1 }],
      },
    });
    await invoke("insert_row", { windowLabel, table, values: [] });
    const bundle = join(state, "pg-real.ixtr");
    await invoke("export_runtime_bundle", {
      windowLabel,
      path: bundle,
      options: { version: "1.0.0", releaseNotes: "" },
    });
    await invoke("clear_datasource_password", { windowLabel, passwordRef });
    const { user, bar } = await openBundle(bundle);

    const dialog = await screen.findByRole("dialog", { name: "Database login" }, LONG);
    expect(dialog).toHaveTextContent("Connection security: sslmode disable.");
    await user.click(within(dialog).getByRole("checkbox", { name: /I accept sending my password/ }));
    await user.type(within(dialog).getByLabelText("Database password"), "wrong-password-9");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert", {}, LONG)).toHaveTextContent(
      /The database refused this login/,
    );
    expect(dialog).not.toHaveTextContent("wrong-password-9");

    await user.click(within(dialog).getByLabelText("Database password"));
    await user.paste(secret);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(
      await screen.findByText(
        `Connected to the database as ${login}. The login is saved on this computer.`,
        {},
        LONG,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Database login" })).toBeNull();
    expect((await readPage(table)).rows).toHaveLength(1);
    expect(await invoke<Json>("runtime_datasource_login_status", { windowLabel })).toMatchObject({
      attached: true,
      source: "installation",
      user: login,
      needsLogin: false,
    });
    for (const file of files(join(state, "data")))
      expect(readFileSync(file).includes(`password=${secret}`), file).toBe(false);

    await user.click(within(bar).getByRole("button", { name: "Database login…" }));
    const again = await screen.findByRole("dialog", { name: "Database login" }, LONG);
    expect(within(again).getByRole("status")).toHaveTextContent(`Connected as ${login}.`);
    await user.click(within(again).getByRole("button", { name: "Forget saved login" }));
    expect(
      await screen.findByText("The saved database login was removed from this computer.", {}, LONG),
    ).toBeInTheDocument();
    expect(await invoke<Json>("runtime_datasource_login_status", { windowLabel })).toMatchObject({
      attached: false,
      source: "none",
      needsLogin: true,
    });
    expect(screen.getByRole("dialog", { name: "Database login" })).toBeInTheDocument();
  },
  120_000,
);
