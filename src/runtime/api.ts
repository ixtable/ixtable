import { call } from "../lib/api";

/** An image asset as a `data:` URL (images up to 5 MB). */
export const readAssetDataUrl = (id: string) => call<string>("read_asset_data_url", { id });

/** Makes Rust enforce the role previewed in Run mode (null ends the preview). */
export const setRuntimeRolePreview = (roleId: string | null) =>
  call<void>("set_runtime_role_preview", { roleId });
