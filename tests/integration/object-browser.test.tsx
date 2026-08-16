import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { renderNewDocument } from "./helpers";

it("shows a flat combined object list and expands the relationship browser until selection", async () => {
  const user = await renderNewDocument();
  expect(screen.getByRole("heading", { name: "Tables" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Views" })).not.toBeInTheDocument();
  expect(document.querySelector(".object-browser details")).not.toBeInTheDocument();
  expect(screen.getByText("Relationship Browser")).toBeInTheDocument();
  expect(document.querySelector(".workbench")).toHaveClass("relationship-only");
  expect(document.querySelector(".data-pane")).not.toBeInTheDocument();

  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name: "People",
      columns: [
        {
          name: "id",
          declaredType: "INTEGER",
          nullable: false,
          primaryKeyPosition: 1,
          unique: false,
          defaultExpression: null,
          generatedExpression: null,
        },
      ],
      foreignKeys: [],
      checks: [],
      withoutRowid: false,
    },
  });
  window.dispatchEvent(new Event("ixtable:database-changed"));
  const item = await screen.findByRole("button", { name: "People" });
  expect(item.querySelector("svg")).toBeInTheDocument();
  expect(item.querySelector(".lucide-eye")).not.toBeInTheDocument();
  expect(within(item).queryByText(/rows/i)).not.toBeInTheDocument();
  expect(document.querySelector(".workbench")).toHaveClass("relationship-only");

  await user.click(item);
  await waitFor(() =>
    expect(document.querySelector(".workbench")).not.toHaveClass("relationship-only"),
  );
  expect(document.querySelector(".data-pane")).toBeInTheDocument();
});
