import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;

type Control = {
  id: string;
  kind: string;
  label: string;
  assetId?: string | null;
  placement: { column: number; columnSpan: number; region?: string | null };
};
type Form = {
  controls: Control[];
  layout: {
    columns: Array<{ kind: string; value?: number | null }>;
    namedRegions: Array<{ name: string }>;
    justifyItems: string;
  };
};
const readForm = async () =>
  (
    await invoke<{ design: { forms: Form[] } }>("read_document_config", {
      windowLabel: "main",
    })
  ).design.forms[0];
const control = async (kind: string) => (await readForm()).controls.find((c) => c.kind === kind);
const properties = () => within(screen.getByRole("complementary", { name: "Properties" }));

async function openDesigner(user: User) {
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
}

async function narrow(user: User, label: string, times: number) {
  const item = await screen.findByRole("group", { name: label }, LONG);
  await user.click(item);
  item.focus();
  await user.keyboard(`{Alt>}${"{ArrowLeft}".repeat(times)}{/Alt}`);
}

it("limits keyboard resizing per control kind", async () => {
  const user = await renderNewDocument();
  await openDesigner(user);

  await user.click(screen.getByRole("button", { name: "Add Related records" }));
  await narrow(user, "New related records", 10);
  await waitFor(async () => expect((await control("relatedList"))?.placement.columnSpan).toBe(6));
  expect(screen.getByRole("button", { name: "Narrow New related records" })).toBeDisabled();
  expect(properties().getByRole("spinbutton", { name: "Column span" })).toHaveValue(6);

  await user.click(screen.getByRole("button", { name: "Add Yes/No" }));
  await narrow(user, "New yes/no", 10);
  await waitFor(async () => expect((await control("boolean"))?.placement.columnSpan).toBe(1));
}, 120_000);

it("edits tracks, alignment and regions, and hides 'Enabled when' on static controls", async () => {
  const user = await renderNewDocument();
  await openDesigner(user);

  await user.selectOptions(properties().getByLabelText("Column 1 size kind"), "fixed");
  await user.selectOptions(properties().getByLabelText("Horizontal alignment"), "center");
  await waitFor(async () => {
    const { layout } = await readForm();
    expect(layout.columns[0]).toMatchObject({ kind: "fixed", value: 120 });
    expect(layout.columns).toHaveLength(12);
    expect(layout.justifyItems).toBe("center");
  }, LONG);
  await user.click(properties().getByRole("button", { name: "Add region" }));
  await waitFor(async () =>
    expect((await readForm()).layout.namedRegions.map((r) => r.name)).toEqual(["region1"]),
  );

  await user.click(screen.getByRole("button", { name: "Add Text" }));
  expect(properties().queryByRole("textbox", { name: "Enabled when" })).toBeNull();
  expect(properties().getByRole("textbox", { name: "Visible when" })).toBeInTheDocument();
  await user.selectOptions(properties().getByRole("combobox", { name: "Region" }), "region1");
  await waitFor(async () => expect((await control("label"))?.placement.region).toBe("region1"));
  expect(properties().getByRole("spinbutton", { name: "Column span" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Add Section" }));
  expect(properties().getByRole("textbox", { name: "Enabled when" })).toBeInTheDocument();

  await user.click(properties().getByRole("button", { name: "Back to form properties" }));
  const span = properties().getByRole("spinbutton", { name: "Region 1 column span" });
  await user.type(span, "0");
  await user.tab();
  await waitFor(async () =>
    expect((await readForm()).layout.namedRegions[0]).toMatchObject({ columnSpan: 12 }),
  );
}, 120_000);

it("renames and removes a region a control uses and keeps the document saveable", async () => {
  const user = await renderNewDocument();
  await openDesigner(user);
  await user.click(properties().getByRole("button", { name: "Add region" }));
  await user.click(screen.getByRole("button", { name: "Add Text" }));
  await user.selectOptions(properties().getByRole("combobox", { name: "Region" }), "region1");
  await waitFor(async () => expect((await control("label"))?.placement.region).toBe("region1"));

  await user.click(properties().getByRole("button", { name: "Back to form properties" }));
  const name = properties().getByRole("textbox", { name: "Region 1 name" });
  await user.clear(name);
  await user.tab();
  expect(await properties().findByRole("alert", {}, LONG)).toHaveTextContent(
    "Region name is required.",
  );
  await user.type(name, "header{Enter}");
  await waitFor(async () => {
    const form = await readForm();
    expect(form.layout.namedRegions.map((r) => r.name)).toEqual(["header"]);
    expect(form.controls.find((c) => c.kind === "label")?.placement.region).toBe("header");
  }, LONG);

  await user.selectOptions(properties().getByLabelText("Horizontal alignment"), "end");
  await waitFor(async () => expect((await readForm()).layout.justifyItems).toBe("end"), LONG);

  await user.click(properties().getByRole("button", { name: "Remove region 1" }));
  await waitFor(async () => {
    const form = await readForm();
    expect(form.layout.namedRegions).toEqual([]);
    expect(form.controls.find((c) => c.kind === "label")?.placement.region ?? null).toBeNull();
  }, LONG);
  await user.selectOptions(properties().getByLabelText("Horizontal alignment"), "start");
  await waitFor(async () => expect((await readForm()).layout.justifyItems).toBe("start"), LONG);
}, 120_000);

it("applies a typed span on blur instead of snapping each keystroke", async () => {
  const user = await renderNewDocument();
  await openDesigner(user);
  await user.click(screen.getByRole("button", { name: "Add Related records" }));
  const span = properties().getByRole("spinbutton", { name: "Column span" });
  await user.clear(span);
  await user.type(span, "10");
  expect(span).toHaveValue(10);
  await user.tab();
  await waitFor(async () => expect((await control("relatedList"))?.placement.columnSpan).toBe(10));
}, 120_000);

it("picks an image asset by its stable id and previews it", async () => {
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Assets" }));
  const dir = mkdtempSync(join(process.env.IXTABLE_STATE_DIR ?? "", "image-"));
  const path = join(dir, "logo.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Import asset" }));
  await screen.findByText("Imported logo.png.", {}, LONG);
  const [asset] = await invoke<Array<{ id: string }>>("list_attachments", { windowLabel: "main" });

  await openDesigner(user);
  await user.click(screen.getByRole("button", { name: "Add Image" }));
  const picker = properties().getByRole("combobox", { name: "Image asset" });
  await within(picker).findByRole("option", { name: "logo.png" }, LONG);
  await user.selectOptions(picker, "logo.png");
  await waitFor(async () => expect((await control("image"))?.assetId).toBe(asset.id));
  const preview = properties().getByLabelText("Image preview");
  await waitFor(() => {
    const image = within(preview).getByRole("img", { name: "New image" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  }, LONG);
}, 120_000);
