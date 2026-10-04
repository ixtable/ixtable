import { open, save } from "@tauri-apps/plugin-dialog";

export const chooseAssetToImport = () =>
  open({ title: "Import application asset", multiple: false, directory: false });

export const chooseAssetDestination = (name: string) =>
  save({ title: "Export application asset", defaultPath: name });

export const chooseCheckpointCopyDestination = (name: string) =>
  save({
    title: "Restore checkpoint as a copy",
    defaultPath: `${name}.ixt`,
    filters: [{ name: "ixtable documents", extensions: ["ixt"] }],
  });
