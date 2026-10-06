import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import type { DocumentConfig } from "../../../src/lib/types";
import { loadReportData } from "../../../src/reports/data";
import { layoutReport } from "../../../src/reports/engine";
import { reportPdfBytes } from "../../../src/reports/export";
import { startFromTemplate } from "./journey";

process.env.TZ = "UTC";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/report-goldens");
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const NOW = new Date("2026-01-15T09:30:00.000Z");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function golden(name: string, actual: Uint8Array) {
  const path = join(FIXTURES, name);
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path))
    throw new Error(`Missing golden ${name}; run with UPDATE_GOLDENS=1 to create it`);
  const expected = new Uint8Array(readFileSync(path));
  const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
  expect(decode(actual), `${name} differs; run with UPDATE_GOLDENS=1 if intended`).toBe(
    decode(expected),
  );
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

async function snapshotReports(template: string, expectedReports: string[]) {
  await startFromTemplate(template);
  const config = await invoke<DocumentConfig>("read_document_config", { windowLabel: "main" });
  expect(config.reports.map((r) => r.name)).toEqual(expectedReports);
  for (const report of config.reports) {
    const data = await loadReportData(report, config, report.params ?? {});
    expect(data.rows.length, `${report.name} has seed rows`).toBeGreaterThan(0);
    const assets = Object.fromEntries(
      Object.entries(data.assets).map(([id, a]) => [id, { mediaType: a.mediaType }]),
    );
    const doc = layoutReport(report, data.rows, {
      params: report.params,
      now: NOW,
      tables: data.tables,
      assets,
    });
    expect(doc.diagnostics, `${report.name} lays out without problems`).toEqual([]);
    const { bytes: pdf, warnings } = await reportPdfBytes(doc, data.assets, {
      title: report.name,
      creationDate: NOW.toISOString(),
    });
    expect(warnings, `${report.name} images all print`).toEqual([]);
    const name = `${slug(template)}-${slug(report.name)}`;
    let json = JSON.stringify(doc, null, 1);
    const ids = [
      ...new Set(
        doc.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === "image" ? [i.assetId] : []))),
      ),
    ];
    ids.forEach((id, n) => {
      json = json.replaceAll(id, `{{asset:${n + 1}}}`);
    });
    golden(`${name}.layout.json`, new TextEncoder().encode(`${json}\n`));
    golden(`${name}.pdf`, pdf);
  }
}

it("CRM activity report matches its golden layout and PDF", async () => {
  await snapshotReports("CRM", ["Activity report"]);
});

it("Inventory valuation report matches its golden layout and PDF", async () => {
  await snapshotReports("Inventory", ["Inventory valuation"]);
});

it("Work order sheet matches its golden layout and PDF", async () => {
  await snapshotReports("Work orders", ["Work order sheet"]);
});
