import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };

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
  await screen.findByRole("region", { name: "Form builder" }, LONG);

  await user.selectOptions(screen.getByRole("combobox", { name: "Data table" }), "products");
  await user.click(screen.getByRole("button", { name: "Add Text field" }));
  const bound = await screen.findByRole("combobox", { name: "Bound column" });
  await waitFor(() => expect(bound).toHaveTextContent("name"), LONG);
  await user.clear(screen.getByLabelText("Label"));
  await user.type(screen.getByLabelText("Label"), "Product name");
  await user.selectOptions(screen.getByRole("combobox", { name: "Bound column" }), "name");
  expect(screen.getByRole("group", { name: "Product name" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Bound column" })).toHaveValue(""),
  );
  await user.click(screen.getByRole("button", { name: "Redo" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Bound column" })).toHaveValue("name"),
  );

  await user.click(screen.getByRole("button", { name: "Preview" }));
  const preview = await screen.findByRole("region", { name: "Main form preview" }, LONG);
  expect(await within(preview).findByText("Live product", {}, LONG)).toBeInTheDocument();
  expect(within(preview).getByRole("columnheader", { name: "Product name" })).toBeInTheDocument();

  await user.selectOptions(screen.getByRole("combobox", { name: "Preview mode" }), "detail");
  const detail = await screen.findByRole("region", { name: "Main form preview" }, LONG);
  expect(await within(detail).findByDisplayValue("Live product", {}, LONG)).toBeInTheDocument();
});
