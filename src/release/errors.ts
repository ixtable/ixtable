import type { TauriError } from "../lib/api";

const messages: Record<string, string> = {
  BUNDLE_SIGNATURE:
    "This file is not a valid ixtable runtime bundle, or it was changed after it was signed. It was not opened.",
  BUNDLE_PASSWORD: "The password is incorrect.",
  BUNDLE_PASSWORD_REQUIRED: "This bundle is password protected. Enter its password.",
  BUNDLE_INCOMPATIBLE: "This bundle needs a newer version of ixtable.",
  BUNDLE_SIGNER_MISMATCH:
    "This file is signed by a different developer key than the installed application. It was not opened.",
  BUNDLE_DOWNGRADE: "This bundle is older than the installed version.",
  BUNDLE_SAME_VERSION: "This version is already installed.",
  BUNDLE_MISMATCH: "This file is a different application.",
  BUNDLE_NOT_INSTALLED: "Open this bundle from the start screen before updating it.",
  UPDATE_FAILED: "The update failed and was rolled back. The previous version is still in use.",
  INSTALL_FAILED: "The bundle could not be installed. Nothing was changed.",
  INVALID_VERSION: "Use a semantic version such as 1.2.0.",
  VALIDATION_FAILED: "Fix the problems in this application before exporting.",
  READ_ONLY: "Runtime bundles are read-only.",
  MISSING_FILE: "The file could not be read.",
};

/** Plain-language explanation for a bundle error code, plus the backend detail. */
export function bundleErrorText(error: TauriError): { summary: string; detail: string } {
  const summary = messages[error.code] ?? "The operation failed.";
  return { summary, detail: error.message };
}
