import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import App from "../../../src/App";
import { captureDocument } from "../capture";
import { dialogMock, LONG, tempPath } from "./fixtures";

const FIXTURE = resolve(__dirname, "../../../tests/fixtures/access/template");

/** Every file under a directory, as zip entry names. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Packs the fixture template directory into an uncompressed .accdt (zip). */
function packTemplate(target: string) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const path of files(FIXTURE)) {
    const name = Buffer.from(relative(FIXTURE, path).split("\\").join("/"));
    const data = readFileSync(path);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, name, data);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...local, directory, end]));
  return target;
}

it("imports an Access template with its forms, report, and data", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Import Access database/ }, LONG));
  const dialog = await screen.findByRole("dialog", { name: "Import Access database" });
  dialogMock.open.mockResolvedValueOnce(packTemplate(tempPath("Order Desk.accdt")));
  await user.click(within(dialog).getByRole("button", { name: /Choose file/ }));
  const tables = await within(dialog).findByRole("table", { name: "Access tables" }, LONG);
  expect(within(tables).getByRole("cell", { name: "Customers" })).toBeInTheDocument();
  await captureDocument(document, {
    name: "access-01-inventory",
    expectations: [
      "The Import Access database dialog names the file as an Access template.",
      "It lists the Customers and Orders tables with field and row counts, and counts of queries, forms, reports, macros, and modules.",
      "The Import the data option is checked.",
    ],
  });

  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  const report = await within(dialog).findByRole("region", { name: "Access import report" }, LONG);
  await user.click(within(report).getByText(/What did not convert fully/));
  expect(within(report).getByRole("table", { name: "Conversion notes" })).toBeVisible();
  await captureDocument(document, {
    name: "access-02-report",
    expectations: [
      "The report says how many tables and rows the new document has.",
      "A table counts converted, partly converted, and not converted objects per kind.",
      "The expanded notes explain each loss, such as the VBA module kept as an asset.",
    ],
  });

  await user.click(within(dialog).getByRole("button", { name: "Open document" }));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  await user.click(within(nav).getByRole("button", { name: /Customer List/ }));
  const page = screen.getByRole("region", { name: "Application page" });
  await waitFor(() => expect(within(page).queryByText(/Loading/)).toBeNull(), LONG);
  await within(page).findAllByRole("row", { name: /^Open / }, LONG);
  await captureDocument(document, {
    name: "access-03-runtime",
    expectations: [
      "The imported Order Desk app opens in the Runtime with navigation built from the Access forms and report.",
      "The Customer List page shows the template's sample customers.",
    ],
  });
});
