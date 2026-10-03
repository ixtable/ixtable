/** Where a back link returns to: the list a record was opened from, or the previous page. */
export type BackLink = { label: string; onBack: () => void };

/** The one back affordance of a runtime page: "← <where you came from>". */
export function BackCrumb({ back }: { back: BackLink }) {
  return (
    <nav aria-label="Breadcrumb" className="rt-crumbs">
      <button type="button" aria-label={`Back to ${back.label}`} onClick={back.onBack}>
        <span aria-hidden="true">← </span>
        {back.label}
      </button>
    </nav>
  );
}
