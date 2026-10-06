import { call } from "../lib/api";
import { toBase64 } from "./pdf";
import type { PdfFontSubset } from "./pdf-fonts";
import type { DecodedPng } from "./pdf-images";

export interface ReportAsset {
  id: string;
  mediaType: string;
  dataBase64: string;
}

/** Writes exported PDF bytes of `reportId` to `path` (Rust `write_report_pdf`; a runtime role must be allowed to read it). */
export const writeReportPdf = (path: string, bytes: Uint8Array, reportId: string) =>
  call<void>("write_report_pdf", { path, bytesBase64: toBase64(bytes), reportId });

/** Reads application assets (images) by id (Rust `read_report_assets`). */
export const readReportAssets = (ids: string[]) =>
  call<ReportAsset[]>("read_report_assets", { ids });

export interface AssetSummary {
  id: string;
  displayName: string;
  mediaType: string;
}

/** Application assets for the image picker. */
export const listAssets = () => call<AssetSummary[]>("list_attachments");

export interface PdfResources {
  fonts: PdfFontSubset[];
  /** One per requested PNG, in order; null when it can't be decoded. */
  images: (DecodedPng | null)[];
}

/** Font subsets and decoded PNGs for the PDF writer (Rust `prepare_report_pdf`). */
export const prepareReportPdf = (codePoints: number[], pngsBase64: string[]) =>
  call<PdfResources>("prepare_report_pdf", { codePoints, pngsBase64 });
