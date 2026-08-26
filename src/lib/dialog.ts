import { open, save } from "@tauri-apps/plugin-dialog";

const ixtFilter = { name: "ixtable documents", extensions: ["ixt"] };

export const chooseDocumentToOpen = () =>
  open({
    title: "Open ixtable document",
    multiple: false,
    directory: false,
    filters: [ixtFilter],
  });

export const chooseDocumentDestination = (name: string) =>
  save({
    title: "Save ixtable document",
    defaultPath: name.toLowerCase().endsWith(".ixt") ? name : `${name}.ixt`,
    filters: [ixtFilter],
  });
