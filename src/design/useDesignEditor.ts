import { useCallback, useMemo } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { type DesignControl, type DesignForm, type DesignSchema, upgradeDesign } from "./schema";

/** Design edits through the session-wide config store, so undo/redo covers them. */
export function useDesignEditor() {
  const { config, update } = useDocumentConfig();
  const design = useMemo(() => upgradeDesign(config.design), [config.design]);
  const editDesign = useCallback(
    (mutate: (design: DesignSchema) => DesignSchema, label = "Edit form") =>
      update((draft) => ({ ...draft, design: mutate(draft.design) }), label).catch(() => undefined),
    [update],
  );
  const editForm = useCallback(
    (formId: string, mutate: (form: DesignForm) => DesignForm, label = "Edit form") =>
      editDesign(
        (current) => ({
          ...current,
          forms: current.forms.map((form) => (form.id === formId ? mutate(form) : form)),
        }),
        label,
      ),
    [editDesign],
  );
  const editControl = useCallback(
    (formId: string, controlId: string, patch: Partial<DesignControl>, label = "Edit control") =>
      editForm(
        formId,
        (form) => ({
          ...form,
          controls: form.controls.map((control) =>
            control.id === controlId ? { ...control, ...patch } : control,
          ),
        }),
        label,
      ),
    [editForm],
  );
  return { config, design, update, editDesign, editForm, editControl };
}
