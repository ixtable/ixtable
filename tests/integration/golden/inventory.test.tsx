import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { asTauriError } from "../../../src/lib/api";
import { dialogMock } from "../setup";
import {
  chooseRelated,
  errorsOf,
  eventually,
  expectAlert,
  LONG,
  openPage,
  runtimePage,
  savedQuery,
  scalar,
  showList,
  sql,
  startFromTemplate,
  type User,
  validateDocument,
  withJourney,
} from "./journey";

const APP = "inventory";
const PLACEHOLDER_SHA256 = "f795a9febe71e68963d920336c389277b1c994aa314bdbf90c6e57376ca13e41";
type Asset = { id: string; displayName: string; mediaType: string; checksum: string; size: number };
const assets = () => invoke<Asset[]>("list_attachments", { windowLabel: "main" });
const int = (value: number) => ({ type: "integer", value });

it("Inventory: aggregation queries, valuation report, and low-stock dashboard", async () => {
  await withJourney(APP, "reads", async (journey) => {
    const user = await journey.step("Create Inventory from the start screen", () =>
      startFromTemplate("Inventory"),
    );
    await journey.step("Validate definitions", async () => {
      journey.check("no error issues", errorsOf(await validateDocument()), []);
    });
    await journey.step("Stock on hand by product", async () => {
      journey.check("totals", await savedQuery("Stock by product"), [
        ["BOLT-M8", "Hex bolt M8", 1050],
        ["DRILL-18V", "Cordless drill 18V", 22],
        ["GLOVE-L", "Work gloves (L)", 233],
        ["LADDER-6", "Step ladder 6ft", 2],
        ["NUT-M8", "Hex nut M8", 1200],
        ["TAPE-25", "Measuring tape 25ft", 47],
      ]);
    });
    await journey.step("Stock on hand by product and location (parameter)", async () => {
      journey.check("ST1 only", await savedQuery("Stock on hand", { location: "ST1" }), [
        ["BOLT-M8", "Hex bolt M8", "ST1", 50],
        ["DRILL-18V", "Cordless drill 18V", "ST1", 2],
        ["GLOVE-L", "Work gloves (L)", "ST1", 30],
        ["TAPE-25", "Measuring tape 25ft", "ST1", 1],
      ]);
      journey.check("by location", await savedQuery("Stock by location"), [
        ["ST1", 83, 337.5],
        ["ST2", 9, 85.5],
        ["WH1", 2462, 3660],
      ]);
    });
    await journey.step("Valuation and low stock", async () => {
      const valuation = await savedQuery("Inventory valuation");
      journey.check(
        "valuation total",
        valuation.reduce((sum, r) => sum + Number(r[5]), 0),
        4083,
      );
      journey.check(
        "low stock",
        (await savedQuery("Low stock")).map((r) => `${r[0]}@${r[2]}:${r[3]}<${r[4]}`),
        ["BOLT-M8@ST1:50<100", "DRILL-18V@ST1:2<3", "GLOVE-L@ST2:3<5", "TAPE-25@ST1:1<2"],
      );
    });
    await journey.step("Valuation report: page 1 of N, subtotals, total", async () => {
      await openPage(user, "Inventory valuation");
      const first = await within(runtimePage()).findByRole(
        "img",
        { name: /^Page 1 of \d+$/ },
        LONG,
      );
      expect(within(first).getByText("Inventory valuation")).toBeInTheDocument();
      expect(within(first).getByText("Contoso Parts")).toBeInTheDocument();
      expect(within(first).getByText("Subtotal 382.50")).toBeInTheDocument();
      const pages = Number(first.getAttribute("aria-label")?.split(" of ")[1]);
      for (let page = 1; page < pages; page++)
        await user.click(within(runtimePage()).getByRole("button", { name: "Next page" }));
      const last = await within(runtimePage()).findByRole("img", {
        name: `Page ${pages} of ${pages}`,
      });
      journey.check(
        "grand total on the last page",
        within(last).queryByText("Total inventory value: 4,083.00") !== null,
        true,
      );
    });
    await journey.step("Low-stock dashboard with location filter", async () => {
      await openPage(user, "Stock overview");
      const page = runtimePage();
      const low = await within(page).findByRole("region", { name: "Low-stock items" }, LONG);
      const value = within(page).getByRole("region", { name: "Inventory value" });
      await within(low).findByText("4", {}, LONG);
      await within(value).findByText("$4,083.00", {}, LONG);
      const location = within(page).getByRole("combobox", { name: "Location" });
      await within(location).findByRole("option", { name: "ST2" }, LONG);
      await user.selectOptions(location, "ST2");
      await within(value).findByText("$85.50", {}, LONG);
      journey.check(
        "ST2 low stock",
        (await within(low).findByText("1", {}, LONG)).textContent,
        "1",
      );
    });
  });
}, 120_000);

async function openTransfer(user: User, id: number) {
  await showList(user, "Transfers");
  const page = runtimePage();
  await user.click(await within(page).findByRole("row", { name: `Open ${id}` }, LONG));
  return within(page).findByRole("form", { name: "Transfer" }, LONG);
}

async function newTransfer(
  user: User,
  product: string,
  from: string,
  to: string,
  quantity: number,
) {
  await showList(user, "Transfers");
  const page = runtimePage();
  await user.click(await within(page).findByRole("button", { name: "New transfer" }, LONG));
  const form = await within(page).findByRole("form", { name: "New Transfer" }, LONG);
  await chooseRelated(user, form, "Product", product);
  await chooseRelated(user, form, "From location", from);
  await chooseRelated(user, form, "To location", to);
  await user.type(within(form).getByRole("spinbutton", { name: "Quantity" }), String(quantity));
  await user.click(within(form).getByRole("button", { name: "Create" }));
  return within(page).findByRole("form", { name: "Transfer" }, LONG);
}

async function post(user: User, form: HTMLElement) {
  await user.click(await within(form).findByRole("button", { name: "Post transfer" }, LONG));
}

const movements = () => scalar("SELECT count(*) FROM stock_movements");
const onHand = (sku: string, code: string) =>
  scalar(
    `SELECT sum(m.quantity) FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN locations l ON l.id = m.location_id WHERE p.sku = '${sku}' AND l.code = '${code}'`,
  );

it("Inventory: constraints, transactional transfers, and concurrency policies", async () => {
  await withJourney(APP, "transactions", async (journey) => {
    const user = await journey.step("Create Inventory from the start screen", () =>
      startFromTemplate("Inventory"),
    );
    const page = runtimePage();

    await journey.step("Create a product; SKU pattern and unique SKU", async () => {
      await showList(user, "Products");
      await user.click(await within(page).findByRole("button", { name: "New product" }, LONG));
      const form = await within(page).findByRole("form", { name: "New Product" }, LONG);
      expect(within(form).getByRole("img", { name: "Product photo" })).toBeInTheDocument();
      await user.type(within(form).getByRole("textbox", { name: "SKU" }), "ab");
      await user.type(within(form).getByRole("textbox", { name: "Name" }), "Claw hammer");
      await user.type(within(form).getByRole("spinbutton", { name: "Unit cost" }), "18.5");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(
        await within(form).findByText("Use at least three capital letters, digits, or dashes."),
      ).toBeInTheDocument();
      const sku = within(form).getByRole("textbox", { name: "SKU" });
      await user.clear(sku);
      await user.type(sku, "BOLT-M8");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await expectAlert(form, /Unique constraint failed/);
      await user.clear(sku);
      await user.type(sku, "HAMMER-16");
      await chooseRelated(user, form, "Supplier", "Fabrikam Tools");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await within(page).findByRole("form", { name: "Product" }, LONG);
      journey.check(
        "stored product",
        await sql(
          "SELECT sku, name, supplier_id, unit_cost, unit, active FROM products WHERE sku = 'HAMMER-16'",
        ),
        [["HAMMER-16", "Claw hammer", 3, 18.5, "each", 1]],
      );
    });

    await journey.step("Receive stock through the product's movements list", async () => {
      const list = await within(page).findByRole("region", { name: "Movements" }, LONG);
      await user.click(await within(list).findByRole("button", { name: "Add movements" }, LONG));
      const form = await within(list).findByRole("form", { name: "New Movement" }, LONG);
      await chooseRelated(user, form, "Location", "Downtown store");
      await user.type(within(form).getByRole("spinbutton", { name: "Quantity" }), "12");
      await user.type(within(form).getByRole("textbox", { name: "Reference" }), "PO-1007");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(await within(list).findByRole("cell", { name: "PO-1007" }, LONG)).toBeVisible();
      journey.check("hammer on hand at ST1", await onHand("HAMMER-16", "ST1"), 12);
    });

    await journey.step("Composite primary key rejects a second threshold", async () => {
      const code = await invoke("insert_row", {
        windowLabel: "main",
        table: "reorder_thresholds",
        values: [
          { column: "product_id", value: int(1) },
          { column: "location_id", value: int(1) },
          { column: "min_quantity", value: int(5) },
        ],
      })
        .then(() => "OK")
        .catch((reason: unknown) => asTauriError(reason).code);
      journey.check("error code", code, "CONSTRAINT_VIOLATION");
    });

    await journey.step("Post the seeded transfer: both movements in one transaction", async () => {
      const before = await movements();
      const form = await openTransfer(user, 1);
      await post(user, form);
      await eventually(async () =>
        expect(
          await sql("SELECT status, posted_on IS NOT NULL FROM transfers WHERE id = 1"),
        ).toEqual([["posted", true]]),
      );
      journey.check("two movements", Number(await movements()) - Number(before), 2);
      await waitFor(
        () => expect(within(form).getByRole("button", { name: "Post transfer" })).toBeDisabled(),
        LONG,
      );
      journey.check(
        "stock moved",
        [await onHand("BOLT-M8", "WH1"), await onHand("BOLT-M8", "ST1")],
        [800, 250],
      );
      journey.check(
        "BOLT-M8 is no longer low at ST1",
        (await savedQuery("Low stock")).map((r) => `${r[0]}@${r[2]}`),
        ["DRILL-18V@ST1", "GLOVE-L@ST2", "TAPE-25@ST1"],
      );
    });

    await journey.step("A failing transfer leaves no partial rows", async () => {
      const before = await movements();
      const form = await newTransfer(user, "Hex nut M8", "Main warehouse", "Main warehouse", 10);
      await post(user, form);
      await expectAlert(form, /no record changes were saved/);
      journey.check("no movement written", await movements(), before);
      journey.check(
        "transfer still a draft",
        await sql("SELECT status FROM transfers WHERE id = 2"),
        [["draft"]],
      );
    });

    await journey.step("Insufficient stock is refused before any write", async () => {
      const before = await movements();
      const form = await newTransfer(
        user,
        "Cordless drill 18V",
        "Downtown store",
        "Airport store",
        5,
      );
      await post(user, form);
      await expectAlert(form, "Not enough stock at the source location: 2 on hand.");
      journey.check("no movement written", await movements(), before);
    });

    await journey.step("Optimistic policy on products rejects a stale edit", async () => {
      await showList(user, "Products");
      await user.click(await within(page).findByRole("row", { name: "Open BOLT-M8" }, LONG));
      const detail = await within(page).findByRole("form", { name: "Product" }, LONG);
      const edit = await within(detail).findByRole("button", { name: "Edit" }, LONG);
      await waitFor(() => expect(edit).toBeEnabled(), LONG);
      await user.click(edit);
      const form = await within(page).findByRole("form", { name: "Edit Product" }, LONG);
      const name = await within(form).findByDisplayValue("Hex bolt M8", {}, LONG);
      await invoke("update_row", {
        windowLabel: "main",
        table: "products",
        values: [{ column: "unit_cost", value: { type: "real", value: 0.3 } }],
        identity: [int(1)],
        expected: [{ column: "name", value: { type: "text", value: "Hex bolt M8" } }],
      });
      await user.clear(name);
      await user.type(name, "Hex bolt M8 zinc");
      await user.click(within(form).getByRole("button", { name: "Save" }));
      await expectAlert(form, /Someone else changed this record/);
      journey.check(
        "the other change is kept",
        await sql("SELECT name, unit_cost FROM products WHERE id = 1"),
        [["Hex bolt M8", 0.3]],
      );
    });

    await journey.step("Last-write-wins policy on movements accepts a stale edit", async () => {
      const changed = await invoke<number>("update_row", {
        windowLabel: "main",
        table: "stock_movements",
        values: [{ column: "note", value: { type: "text", value: "Counted" } }],
        identity: [int(1)],
        expected: [{ column: "note", value: { type: "text", value: "stale value" } }],
      });
      journey.check("updated", changed, 1);
      const conflict = await invoke("update_row", {
        windowLabel: "main",
        table: "products",
        values: [{ column: "unit", value: { type: "text", value: "box" } }],
        identity: [int(1)],
        expected: [{ column: "unit", value: { type: "text", value: "stale value" } }],
      })
        .then(() => "OK")
        .catch((reason: unknown) => asTauriError(reason).code);
      journey.check("products still optimistic", conflict, "CONFLICT");
    });
  });
}, 180_000);

it("Inventory: the product image asset and records survive an archive round trip", async () => {
  await withJourney(APP, "archive-round-trip", async (journey) => {
    const user = await journey.step("Create Inventory from the start screen", () =>
      startFromTemplate("Inventory"),
    );
    const [asset] = await assets();
    journey.check(
      "template asset imported",
      [asset.displayName, asset.mediaType, asset.checksum, asset.size],
      ["product-placeholder.png", "image/png", PLACEHOLDER_SHA256, 89],
    );
    const before = await invoke<{
      design: { forms: Array<{ controls: Array<{ assetId?: string }> }> };
    }>("read_document_config", { windowLabel: "main" });
    journey.check(
      "product form shows the asset",
      before.design.forms.flatMap((f) => f.controls).some((c) => c.assetId === asset.id),
      true,
    );
    const records = await sql("SELECT * FROM stock_movements ORDER BY id");
    const archive = join(process.env.IXTABLE_STATE_DIR!, "inventory-golden.ixt");
    await journey.step("Save, close, and reopen", async () => {
      dialogMock.save.mockResolvedValueOnce(archive);
      await user.click(screen.getByRole("button", { name: "Save project" }));
      await screen.findByText("Saved archive", {}, LONG);
      await user.click(screen.getByRole("button", { name: "Close project" }));
      dialogMock.open.mockResolvedValueOnce(archive);
      await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
      await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
    });
    await journey.step("Compare asset, definitions, and records", async () => {
      journey.check(
        "asset checksum",
        (await assets()).map((a) => [a.id, a.checksum]),
        [[asset.id, PLACEHOLDER_SHA256]],
      );
      journey.check(
        "definitions identical",
        await invoke("read_document_config", { windowLabel: "main" }),
        before,
      );
      journey.check(
        "records identical",
        await sql("SELECT * FROM stock_movements ORDER BY id"),
        records,
      );
      const exported = join(process.env.IXTABLE_STATE_DIR!, "exported.png");
      await invoke("export_attachment", { windowLabel: "main", id: asset.id, path: exported });
      const { createHash } = await import("node:crypto");
      const { readFileSync } = await import("node:fs");
      journey.check(
        "exported bytes match",
        createHash("sha256").update(readFileSync(exported)).digest("hex"),
        PLACEHOLDER_SHA256,
      );
    });
  });
}, 120_000);
