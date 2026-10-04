import { call } from "../lib/api";
import { toBase64 } from "./pdf";

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
