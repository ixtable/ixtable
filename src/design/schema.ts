export const DESIGN_SCHEMA_VERSION = 1;
export type ControlKind = "text" | "number" | "select" | "checkbox" | "section";
export type DesignControl = {
  id: string;
  kind: ControlKind;
  label: string;
  binding?: { table: string; column: string } | null;
  validation: {
    required: boolean;
    min?: number | null;
    max?: number | null;
    pattern?: string | null;
  };
  width: "full" | "half";
};
export type DesignForm = {
  id: string;
  name: string;
  table?: string | null;
  controls: DesignControl[];
  layout: { columns: number; gap: number };
};
export type DesignSchema = {
  version: number;
  forms: DesignForm[];
  navigation: { id: string; label: string; formId: string }[];
};

export const newControl = (kind: ControlKind): DesignControl => ({
  id: crypto.randomUUID(),
  kind,
  label: kind === "section" ? "New section" : `New ${kind} field`,
  binding: null,
  validation: { required: false },
  width: "full",
});
