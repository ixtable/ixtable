import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openSettingsTab, renderNewDocument, seedSales, type User } from "./fixtures";

async function pasteInto(user: User, input: HTMLElement, text: string) {
  await user.clear(input);
  await user.click(input);
  await user.paste(text);
}

it("shows the datasource, entities, migrations, YAML, and problems settings tabs", async () => {
  const user = await renderNewDocument();
  await seedSales();

  await openSettingsTab(user, "Datasource");
  await screen.findByRole("heading", { name: "Datasource" }, LONG);
  await user.selectOptions(screen.getByRole("combobox", { name: "Record store" }), "postgres");
  await user.selectOptions(screen.getByRole("combobox", { name: "TLS (sslmode)" }), "disable");
  expect(screen.getByRole("alert")).toHaveTextContent("Severe security warning");
  expect(screen.getByRole("button", { name: "Save datasource" })).toBeDisabled();
  await captureDocument(document, {
    name: "settings-01-datasource",
    expectations: [
      "PostgreSQL connection fields (host, port, database, user, password, TLS) are labelled.",
      "Disabling TLS shows a severe warning with an explicit acceptance checkbox; Save is disabled.",
      "A note warns that shared credentials reduce revocation.",
    ],
  });
  await user.selectOptions(screen.getByRole("combobox", { name: "Record store" }), "sqlite");

  await user.click(screen.getByRole("tab", { name: "Entities" }));
  const policy = await screen.findByRole(
    "combobox",
    { name: "Concurrency policy for orders" },
    LONG,
  );
  await user.selectOptions(policy, "lastWriteWins");
  await captureDocument(document, {
    name: "settings-02-entities",
    expectations: ["Each table has a concurrency policy selector; orders uses last-write-wins."],
  });

  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
  await user.click(screen.getByRole("button", { name: "New migration" }));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  await pasteInto(user, within(editor).getByRole("textbox", { name: "Name" }), "Add order tags");
  await user.click(within(editor).getByRole("textbox", { name: "Up SQL" }));
  await user.paste("CREATE TABLE order_tags (order_id INTEGER, tag TEXT NOT NULL);");
  await user.click(within(editor).getByRole("checkbox", { name: /Reversible/ }));
  await user.click(within(editor).getByRole("textbox", { name: "Down SQL" }));
  await user.paste("DROP TABLE order_tags;");
  await user.click(within(editor).getByRole("button", { name: "Save migration" }));
  await screen.findByRole("cell", { name: "Add order tags" }, LONG);
  const dryRun = await screen.findByRole("button", { name: "Dry run pending" }, LONG);
  await waitFor(() => expect(dryRun).toBeEnabled(), LONG);
  await user.click(dryRun);
  await screen.findByText("Dry run succeeded; nothing was changed.", {}, LONG);
  await captureDocument(document, {
    name: "settings-03-migrations",
    expectations: [
      "The migration list shows Add order tags as pending and reversible.",
      "The dry-run result confirms nothing was changed; Apply pending (1) is offered.",
    ],
  });

  await user.click(screen.getByRole("tab", { name: "YAML" }));
  const yaml = await screen.findByRole("textbox", { name: "Configuration YAML" }, LONG);
  await waitFor(() => expect(yaml).toHaveDisplayValue(/name: Untitled/));
  await captureDocument(document, {
    name: "settings-04-yaml",
    expectations: [
      "The YAML tab shows the document configuration in a monospace editor with Apply YAML.",
    ],
  });
  await pasteInto(
    user,
    yaml,
    "name: Broken\nactiveMode: app\nversion: 3\nreports:\n  - id: r1\n    name: Sales\n  - id: r1\n    name: ''\n",
  );
  await user.click(screen.getByRole("button", { name: "Apply YAML" }));
  await screen.findByText("YAML applied.", {}, LONG);
  await user.click(screen.getByRole("tab", { name: "Problems" }));
  const problems = await screen.findByRole("list", { name: "Problems" }, LONG);
  expect(within(problems).getByText(/duplicate report id r1/)).toBeInTheDocument();
  await captureDocument(document, {
    name: "settings-05-problems",
    expectations: [
      "The Problems tab summarises errors and warnings and lists each with its object.",
      "The duplicate report id error and the missing report name warning are distinguishable.",
    ],
  });
});
