import type { Band, Report, ReportComponent } from "../../src/reports/types";

/** Shared report fixtures for engine, PDF and preview tests. */
export const band = (
  height: number,
  components: ReportComponent[] = [],
  keepTogether = false,
): Band => ({
  height,
  keepTogether,
  components,
});

export function baseReport(patch: Partial<Report["bands"]> = {}): Report {
  return {
    id: "r1",
    name: "Sales",
    params: {},
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { top: 36, right: 36, bottom: 36, left: 36 },
    },
    bands: {
      reportHeader: band(0),
      pageHeader: band(0),
      groups: [],
      detail: band(0),
      pageFooter: band(0),
      reportFooter: band(0),
      ...patch,
    },
  };
}

export const orders = [
  { id: 1, region: "West", customer: "Acme", amount: 120.5, qty: 2, price: 10 },
  { id: 2, region: "East", customer: "Birch", amount: 80, qty: 1, price: 80 },
  { id: 3, region: "West", customer: "Cobalt", amount: 42.25, qty: 3, price: 5 },
  { id: 4, region: "East", customer: "Dune", amount: 10, qty: 4, price: 2.5 },
  { id: 5, region: "North", customer: "Elm", amount: 300, qty: 1, price: 300 },
];
