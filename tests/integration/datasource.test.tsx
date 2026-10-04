import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { insertRow, readPage, refreshDatabase, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };
const postgresUrl = process.env.IXTABLE_TEST_POSTGRES_URL;

async function openTab(user: Awaited<ReturnType<typeof renderNewDocument>>, tab: string) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: tab }));
  await screen.findByRole("heading", { name: tab }, LONG);
}

it("requires an explicit override for non-TLS PostgreSQL and warns about shared credentials", async () => {
  const user = await renderNewDocument();
  await openTab(user, "Datasource");
  await user.selectOptions(screen.getByRole("combobox", { name: "Record store" }), "postgres");
  expect(screen.getByRole("note")).toHaveTextContent("Shared credentials reduce revocation");
  await user.selectOptions(screen.getByRole("combobox", { name: "TLS (sslmode)" }), "disable");
  const warning = screen.getByRole("alert");
  expect(warning).toHaveTextContent("Severe security warning");
  const save = screen.getByRole("button", { name: "Save datasource" });
  const test = screen.getByRole("button", { name: "Test connection" });
  expect(save).toBeDisabled();
  expect(test).toBeDisabled();
  await user.click(
    within(warning).getByRole("checkbox", { name: /accept connecting without TLS/ }),
  );
  expect(save).toBeEnabled();
  expect(test).toBeEnabled();
  await user.selectOptions(screen.getByRole("combobox", { name: "Credential mode" }), "perUser");
  expect(screen.queryByRole("note")).toBeNull();
  await user.click(screen.getByText("SQLite store capabilities"));
  expect(screen.getByRole("table", { name: "Schema change modes" })).toHaveTextContent(
    "Requires table rebuild",
  );
});

it("never releases a stored password to a different server or over unconfirmed plaintext", async () => {
  await renderNewDocument();
  const good = {
    kind: "postgres",
    id: `ds-${Date.now()}`,
    host: "db.internal.example",
    port: 5432,
    database: "app",
    user: "app",
    sslmode: "require",
  };
  const passwordRef = await invoke<string>("set_datasource_password", {
    windowLabel: "main",
    datasourceId: good.id,
    password: "victim-secret",
    datasource: good,
  });
  const attempt = (datasource: Record<string, unknown>) =>
    invoke("test_datasource_connection", {
      windowLabel: "main",
      datasource: { ...datasource, passwordRef },
      password: null,
    }).then(
      () => "connected",
      (e: unknown) => String((e as Error).message ?? e),
    );
  await expect(attempt({ ...good, host: "evil.example" })).resolves.toMatch(
    /CREDENTIAL_TARGET_MISMATCH.*Re-enter the password/,
  );
  await expect(attempt({ ...good, user: "postgres" })).resolves.toMatch(
    /CREDENTIAL_TARGET_MISMATCH/,
  );
  await expect(attempt({ ...good, sslmode: "disable" })).resolves.toMatch(/INSECURE_TRANSPORT/);
  await invoke("clear_datasource_password", { windowLabel: "main", passwordRef });
});

it("sets a concurrency policy per table and flags tables without one", async () => {
  const user = await renderNewDocument();
  await openTab(user, "Entities");
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name: "orders",
      columns: [{ name: "id", logicalType: "integer", nullable: false, primaryKeyPosition: 1 }],
    },
  });
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  await invoke("update_document_config", {
    windowLabel: "main",
    config: {
      ...config,
      migrations: [
        {
          id: "m-legacy",
          name: "Legacy",
          order: 1,
          up: "CREATE TABLE legacy (id INTEGER PRIMARY KEY)",
        },
      ],
    },
  });
  await invoke("apply_migrations", { windowLabel: "main" });
  await refreshDatabase();
  const issues = await invoke<Array<{ objectId: string; message: string }>>("validate_document", {
    windowLabel: "main",
  });
  expect(issues).toContainEqual(
    expect.objectContaining({
      objectId: "legacy",
      message: expect.stringMatching(/no resolved concurrency policy/),
    }),
  );
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Entities" }));
  const legacyRow = await screen.findByRole("row", { name: /^legacy/ }, LONG);
  expect(within(legacyRow).getByText("No resolved policy")).toBeInTheDocument();
  const policy = await screen.findByRole(
    "combobox",
    { name: "Concurrency policy for orders" },
    LONG,
  );
  expect(policy).toHaveValue("optimistic");
  await user.selectOptions(policy, "lastWriteWins");
  await waitFor(async () => {
    const config = await invoke<{ entities: Array<{ table: string; concurrency: string }> }>(
      "read_document_config",
      { windowLabel: "main" },
    );
    expect(config.entities).toMatchObject([{ table: "orders", concurrency: "lastWriteWins" }]);
  }, LONG);
});

it.skipIf(!postgresUrl)(
  "switches reads and writes to PostgreSQL without storing the password in the document",
  async () => {
    const url = new URL(postgresUrl!);
    const table = `ixt_ui_${Date.now()}`;
    const user = await renderNewDocument();
    await openTab(user, "Datasource");
    await user.selectOptions(screen.getByRole("combobox", { name: "Record store" }), "postgres");
    await user.type(screen.getByRole("textbox", { name: "Host" }), url.hostname);
    const port = screen.getByRole("spinbutton", { name: "Port" });
    await user.clear(port);
    await user.type(port, url.port || "5432");
    await user.type(screen.getByRole("textbox", { name: "Database" }), url.pathname.slice(1));
    await user.type(
      screen.getByRole("textbox", { name: "User" }),
      decodeURIComponent(url.username),
    );
    await user.type(screen.getByLabelText("Password"), "not-needed-with-trust-auth");
    await user.selectOptions(screen.getByRole("combobox", { name: "TLS (sslmode)" }), "disable");
    await user.click(screen.getByRole("checkbox", { name: /accept connecting without TLS/ }));
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status", {}, LONG)).toHaveTextContent("WITHOUT TLS");
    await user.click(screen.getByRole("button", { name: "Save datasource" }));
    expect(
      await screen.findByText(/Reads now use the PostgreSQL store/, {}, LONG),
    ).toBeInTheDocument();

    const config = await invoke<{ datasource: Record<string, unknown> }>("read_document_config", {
      windowLabel: "main",
    });
    expect(config.datasource.passwordRef).toMatch(/^datasource:/);
    expect(JSON.stringify(config)).not.toContain("not-needed-with-trust-auth");
    expect(config.datasource.insecureTransportConfirmedAt).toBeTruthy();
    const yaml = await invoke<string>("read_document_config_yaml", { windowLabel: "main" });
    expect(yaml).not.toContain("not-needed-with-trust-auth");

    await invoke("create_database_table", {
      windowLabel: "main",
      spec: {
        name: table,
        columns: [
          { name: "id", logicalType: "integer", nullable: false, primaryKeyPosition: 1 },
          { name: "amount", logicalType: "decimal(12,2)", nullable: true },
          { name: "at", logicalType: "timestamp", nullable: true },
        ],
      },
    });
    await insertRow(table, [
      { column: "amount", value: value("text", "19.9") },
      { column: "at", value: value("text", "2024-05-01T08:30:00Z") },
    ]);
    const page = await readPage(table);
    expect(page.rows).toEqual([
      [value("integer", 1), value("decimal", "19.90"), value("timestamp", "2024-05-01T08:30:00")],
    ]);
    const capabilities = await invoke<{ store: string }>("store_capabilities", {
      windowLabel: "main",
    });
    expect(capabilities.store).toBe("postgres");
    await invoke("drop_database_table", { windowLabel: "main", table });

    const current = await invoke<Record<string, unknown>>("read_document_config", {
      windowLabel: "main",
    });
    await invoke("update_document_config", {
      windowLabel: "main",
      config: {
        ...current,
        migrations: [
          {
            id: `m-${table}`,
            name: "PG migration",
            order: 1,
            up: `CREATE TABLE ${table}_m (id INTEGER PRIMARY KEY)`,
          },
        ],
      },
    });
    await expect(
      invoke("apply_migrations", { windowLabel: "main" }).then(
        () => "applied",
        (e: unknown) => String((e as Error).message ?? e),
      ),
    ).resolves.toMatch(/VALIDATION_ERROR.*Migrations apply to the embedded SQLite store only/);
    await openTab(user, "Migrations");
    expect(
      await screen.findByRole("note", { name: "Migrations disabled" }, LONG),
    ).toHaveTextContent("disabled for this document because it uses PostgreSQL");
    expect(await screen.findByRole("button", { name: "Apply pending (0)" }, LONG)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back last" })).toBeDisabled();
    const objects = await invoke<Array<{ name: string }>>("list_database_objects", {
      windowLabel: "main",
    });
    expect(objects.map((o) => o.name)).not.toContain(`${table}_m`);
  },
);
