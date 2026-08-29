import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";

it("edits, binds, undoes, and previews a design with live data", async () => {
  const user = await renderNewDocument();
  await createTable("products", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await insertRow("products", [
    { column: "id", value: value("integer", 1) },
    { column: "name", value: value("text", "Live product") },
  ]);
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" });

  await user.selectOptions(screen.getByRole("combobox", { name: "Data table" }), "products");
  await user.click(screen.getByRole("button", { name: "Text field" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Bound column" })).toHaveTextContent("name"),
  );
  await user.clear(screen.getByLabelText("Label"));
  await user.type(screen.getByLabelText("Label"), "Product name");
  await user.selectOptions(screen.getByRole("combobox", { name: "Bound column" }), "name");

  await user.click(screen.getByRole("button", { name: "Undo" }));
  await user.click(screen.getByRole("button", { name: "Redo" }));
  await user.click(screen.getByRole("button", { name: "Preview app" }));
  expect(await screen.findByText("Live product")).toBeInTheDocument();
  expect(screen.getByText("Product name")).toBeInTheDocument();
});
