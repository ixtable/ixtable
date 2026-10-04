import type { Page, PositionedItem, ReportDocument } from "./engine";

/** Gray level (0 black … 1 white) as a CSS color. */
const grayCss = (level: number) => {
  const v = Math.round(Math.min(1, Math.max(0, level)) * 255);
  return `rgb(${v}, ${v}, ${v})`;
};

/** Same fallbacks as the metrics table: Arial/Liberation Sans share Helvetica's widths. */
const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

function Item({
  item,
  imageUrl,
}: {
  item: PositionedItem;
  imageUrl: (id: string) => string | undefined;
}) {
  switch (item.kind) {
    case "rect":
      return (
        <rect
          x={item.x}
          y={item.y}
          width={item.w}
          height={item.h}
          fill={item.fill === null ? "none" : grayCss(item.fill)}
          stroke={item.lineWidth > 0 ? grayCss(item.gray) : "none"}
          strokeWidth={item.lineWidth || undefined}
        />
      );
    case "line":
      return (
        <line
          x1={item.x}
          y1={item.y}
          x2={item.x + item.w}
          y2={item.y + item.h}
          stroke={grayCss(item.gray)}
          strokeWidth={item.lineWidth}
        />
      );
    case "text":
      return (
        <>
          {item.lines.map((line, i) => (
            <text
              key={i}
              x={line.x}
              y={line.y}
              fontFamily={FONT_FAMILY}
              fontSize={item.fontSize}
              fontWeight={item.bold ? "bold" : "normal"}
              fill={grayCss(item.gray)}
              textLength={line.width > 0 ? line.width : undefined}
              lengthAdjust="spacingAndGlyphs"
              xmlSpace="preserve"
            >
              {line.text}
            </text>
          ))}
        </>
      );
    case "image": {
      const href = imageUrl(item.assetId);
      if (!href)
        return (
          <rect x={item.x} y={item.y} width={item.w} height={item.h} fill="none" stroke="#888" />
        );
      return (
        <image
          href={href}
          x={item.x}
          y={item.y}
          width={item.w}
          height={item.h}
          preserveAspectRatio="none"
        />
      );
    }
  }
}

/**
 * One report page as SVG in points. `zoom` scales the on-screen size; with
 * `unit="pt"` the page prints at its exact paper size.
 */
export function PageView({
  doc,
  page,
  zoom = 1,
  unit = "px",
  label,
  imageUrl,
}: {
  doc: ReportDocument;
  page: Page;
  zoom?: number;
  unit?: "px" | "pt";
  label: string;
  imageUrl: (id: string) => string | undefined;
}) {
  return (
    <svg
      role="img"
      aria-label={label}
      className="report-page"
      viewBox={`0 0 ${doc.width} ${doc.height}`}
      width={`${doc.width * zoom}${unit}`}
      height={`${doc.height * zoom}${unit}`}
    >
      <rect x={0} y={0} width={doc.width} height={doc.height} fill="#fff" />
      {page.items.map((item, i) => (
        <Item key={i} item={item} imageUrl={imageUrl} />
      ))}
    </svg>
  );
}
