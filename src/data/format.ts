import type { DataValue } from "../lib/types";

export const showValue = (v: DataValue) =>
  v.type === "null"
    ? "NULL"
    : v.type === "blob"
      ? `Blob (${String(v.value || "").length} base64 chars)`
      : String(v.value ?? "");
