import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, renderNewDocument } from "./fixtures";

type Form = {
  controls: Array<{ kind: string; placement: { region?: string | null } }>;
  layout: { columns: Array<{ kind: string }>; namedRegions: Array<{ name: string }> };
};
const readForm = async () =>
  (await invoke<{ design: { forms: Form[] } }>("read_document_config", { windowLabel: "main" }))
    .design.forms[0];
const properties = () => within(screen.getByRole("complementary", { name: "Properties" }));

it("edits grid tracks and named regions and places a control in a region", async () => {
  const user = await renderNewDocument();
  await openMode(user, "Design");
  await screen.findByRole("region", { name: "Form builder" }, LONG);

  await user.selectOptions(properties().getByLabelText("Column 1 size kind"), "fixed");
  await user.click(properties().getByRole("button", { name: "Add region" }));
  const name = properties().getByRole("textbox", { name: "Region 1 name" });
  await user.clear(name);
  await user.type(name, "header{Enter}");
  await waitFor(async () => {
    const { layout } = await readForm();
    expect(layout.columns[0].kind).toBe("fixed");
    expect(layout.namedRegions.map((r) => r.name)).toEqual(["header"]);
  }, LONG);
  await captureDocument(document, {
    name: "grid-01-tracks-and-regions",
    expectations: [
      "Form properties list the column tracks with Column 1 set to 'Fixed (px)', its name, kind, and labelled Size, Min, and Max inputs readable.",
      "A named region 'header' appears in the region editor with its column, row, and span inputs.",
    ],
  });

  await user.click(screen.getByRole("button", { name: "Add Text" }));
  await user.selectOptions(properties().getByRole("combobox", { name: "Region" }), "header");
  await waitFor(
    async () =>
      expect((await readForm()).controls.find((c) => c.kind === "label")?.placement.region).toBe(
        "header",
      ),
    LONG,
  );
  expect(properties().getByRole("spinbutton", { name: "Column span" })).toBeDisabled();
  expect(
    properties().getByText("Placed in a region; choose None to set column and row."),
  ).toBeInTheDocument();
  await captureDocument(document, {
    name: "grid-02-control-in-region",
    expectations: [
      "The Text control's Region select reads 'header'.",
      "Its column and span inputs are disabled, with the hint 'Placed in a region; choose None to set column and row.'",
    ],
  });

  await user.click(properties().getByRole("button", { name: "Back to form properties" }));
  const regionName = properties().getByRole("textbox", { name: "Region 1 name" });
  await user.clear(regionName);
  await user.tab();
  expect(await properties().findByRole("alert", {}, LONG)).toHaveTextContent(
    "Region name is required.",
  );
  await captureDocument(document, {
    name: "grid-03-region-name-required",
    expectations: [
      "The Region 1 name input is empty and shows 'Region name is required.' inline beneath it.",
    ],
  });
});
