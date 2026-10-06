import { call } from "../lib/api";
import type {
  FilePreview,
  FileSourceInfo,
  ImportReport,
  ImportTarget,
  ParseOptions,
} from "./types";

export const previewImportFile = (path: string, options: ParseOptions) =>
  call<FilePreview>("preview_import_file", { path, options });
export const importFile = (path: string, options: ParseOptions, target: ImportTarget) =>
  call<ImportReport>("import_file", { request: { path, options, target } });
export const fileSourceInfo = () => call<FileSourceInfo[]>("file_source_info");
