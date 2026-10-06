import { open } from "@tauri-apps/plugin-dialog";

export const chooseFileToImport = () =>
  open({
    title: "Import records",
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Data files",
        extensions: ["csv", "tsv", "txt", "xlsx", "json", "ndjson", "parquet"],
      },
    ],
  });

export const chooseFileSource = () =>
  open({
    title: "Add file source",
    multiple: false,
    directory: false,
    filters: [
      { name: "Data files", extensions: ["csv", "tsv", "txt", "json", "ndjson", "parquet"] },
    ],
  });
