import { useEffect, useState } from "react";
import { type AssetSummary, listAssets } from "../reports/api";
import { ImageView } from "../runtime/controls";
import type { DesignControl } from "./schema";

/**
 * Image asset picker for the image control: the same asset list the report designer uses,
 * filtered to images, with a preview. The stored value stays the stable asset id.
 */
export function AssetPicker({
  control,
  onChange,
}: {
  control: DesignControl;
  onChange: (assetId: string | null) => void;
}) {
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    listAssets()
      .then((list) => live && setAssets(list))
      .catch(() => live && setAssets([]));
    return () => {
      live = false;
    };
  }, []);
  const images = (assets ?? []).filter((a) => a.mediaType.startsWith("image/"));
  const current = control.assetId ?? "";
  return (
    <>
      <label>
        Image asset
        <select value={current} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">None</option>
          {current && assets && !images.some((a) => a.id === current) && (
            <option value={current}>Missing asset ({current})</option>
          )}
          {images.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </label>
      {assets && !images.length && (
        <p className="fd-hint">Add image assets in App settings to use them here.</p>
      )}
      {current && (
        <div className="fd-asset-preview" aria-label="Image preview">
          <ImageView control={control} />
        </div>
      )}
    </>
  );
}
