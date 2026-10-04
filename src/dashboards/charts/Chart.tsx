/**
 * Dependency-free SVG charts for dashboards. Every chart is an `img` with a title and a
 * text summary, carries a native tooltip per mark, shows a legend for two or more
 * series, and renders its data as a visually hidden table for assistive technology.
 */
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  type CategoryData,
  chartData,
  formatNumber,
  type Row,
  type ScatterData,
  scatterData,
} from "../data";
import type { ChartType, DashboardComponent } from "../types";
import {
  barGeometry,
  DEFAULT_FRAME,
  type Frame,
  lineGeometry,
  pieGeometry,
  plotArea,
  scatterGeometry,
  sparkline,
  type AxisLabel,
} from "./geometry";
import {
  AXIS,
  GRID,
  INK,
  MAX_SERIES,
  MUTED,
  OTHER_COLOR,
  OTHER_LABEL,
  seriesColor,
  SURFACE,
} from "./palette";
import type { Ticks } from "./scale";

export type ChartSpec = Pick<DashboardComponent, "x" | "y" | "groupBy" | "stacked" | "format"> & {
  chartType: ChartType;
};

const TYPE_NAMES: Record<ChartType, string> = {
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
  pie: "Pie chart",
  donut: "Donut chart",
  scatter: "Scatter plot",
  summary: "Summary",
};

// Charts draw in SVG units equal to the measured container width (480 until measured).
const FrameContext = createContext<Frame>(DEFAULT_FRAME);
const useFrame = () => {
  const frame = useContext(FrameContext);
  return { frame, plot: plotArea(frame) };
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(Math.max(240, Math.round(next / 10) * 10));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function ChartBody({ spec, title, rows }: { spec: ChartSpec; title: string; rows: Row[] }) {
  const name = title || TYPE_NAMES[spec.chartType];
  if (!rows.length)
    return (
      <p className="dash-empty" role="note">
        No data for {name}.
      </p>
    );
  switch (spec.chartType) {
    case "scatter":
      return (
        <Scatter spec={spec} title={name} data={scatterData(spec as DashboardComponent, rows)} />
      );
    case "pie":
    case "donut":
      return <Pie spec={spec} title={name} data={chartData(spec as DashboardComponent, rows)} />;
    case "summary":
      return (
        <Summary spec={spec} title={name} data={chartData(spec as DashboardComponent, rows)} />
      );
    default:
      return (
        <Cartesian spec={spec} title={name} data={chartData(spec as DashboardComponent, rows)} />
      );
  }
}

export function Chart(props: { spec: ChartSpec; title: string; rows: Row[] }) {
  const [ref, width] = useWidth();
  const frame = width ? { ...DEFAULT_FRAME, width } : DEFAULT_FRAME;
  return (
    <div ref={ref} className="dash-chart-box">
      <FrameContext.Provider value={frame}>
        <ChartBody {...props} />
      </FrameContext.Provider>
    </div>
  );
}

const fmt = (value: number | null, spec: ChartSpec) => formatNumber(value, spec.format);

function describe(spec: ChartSpec, data: CategoryData) {
  const values = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const range = values.length
    ? ` Values from ${fmt(Math.min(...values), spec)} to ${fmt(Math.max(...values), spec)}.`
    : "";
  const series = data.series.length === 1 ? "1 series" : `${data.series.length} series`;
  return `${TYPE_NAMES[spec.chartType]}${spec.stacked ? ", stacked" : ""}: ${series} over ${data.categories.length} ${spec.x ?? "categories"}.${range}`;
}

function Figure({
  className,
  title,
  summary,
  legend,
  table,
  viewBox,
  children,
}: {
  className?: string;
  title: string;
  summary: string;
  legend?: { name: string; color: string }[];
  table: ReactNode;
  viewBox: string;
  children: ReactNode;
}) {
  return (
    <figure className={className ? `dash-chart ${className}` : "dash-chart"}>
      <svg
        viewBox={viewBox}
        role="img"
        aria-label={`${title}. ${summary}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{title}</title>
        <desc>{summary}</desc>
        {children}
      </svg>
      {legend && legend.length > 1 && (
        <ul className="dash-legend" aria-label={`${title} legend`}>
          {legend.map((item) => (
            <li key={item.name}>
              <span className="dash-swatch" style={{ background: item.color }} aria-hidden="true" />
              {item.name}
            </li>
          ))}
        </ul>
      )}
      {table}
    </figure>
  );
}

function DataTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="dash-sr-only">
      <caption>{title} data</caption>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) =>
              j === 0 ? (
                <th key={j} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={j}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const categoryTable = (title: string, spec: ChartSpec, data: CategoryData) => (
  <DataTable
    title={title}
    head={[spec.x || "Category", ...data.series.map((s) => s.name)]}
    rows={data.categories.map((c, i) => [c, ...data.series.map((s) => fmt(s.values[i], spec))])}
  />
);

/** Horizontal gridlines with value labels on the left. */
function YAxis({
  ticks,
  spec,
  scale,
}: {
  ticks: Ticks;
  spec: ChartSpec;
  scale: (v: number) => number;
}) {
  const { plot } = useFrame();
  return (
    <g aria-hidden="true">
      {ticks.ticks.map((t) => (
        <g key={t}>
          <line x1={plot.left} x2={plot.right} y1={scale(t)} y2={scale(t)} stroke={GRID} />
          <text
            x={plot.left - 6}
            y={scale(t)}
            dy="0.32em"
            textAnchor="end"
            fill={MUTED}
            fontSize={11}
          >
            {fmt(t, spec)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Category labels under the plot; thinned and truncated so they do not collide. */
function XLabels({ labels }: { labels: AxisLabel[] }) {
  const { plot } = useFrame();
  const band = labels.length ? (plot.right - plot.left) / labels.length : 0;
  const every = Math.max(1, Math.ceil(40 / Math.max(1, band)));
  const chars = Math.max(3, Math.floor((band * every) / 7));
  return (
    <g aria-hidden="true">
      {labels.map((label, i) =>
        i % every ? null : (
          <text
            key={i}
            x={label.x}
            y={plot.bottom + 16}
            textAnchor="middle"
            fill={MUTED}
            fontSize={11}
          >
            {label.text.length > chars ? `${label.text.slice(0, chars - 1)}…` : label.text}
          </text>
        ),
      )}
    </g>
  );
}

const yScaleOf = (ticks: Ticks, plot: ReturnType<typeof plotArea>) => (v: number) =>
  ticks.max === ticks.min
    ? plot.bottom
    : plot.bottom - ((v - ticks.min) / (ticks.max - ticks.min)) * (plot.bottom - plot.top);

function Cartesian({ spec, title, data }: { spec: ChartSpec; title: string; data: CategoryData }) {
  const { frame, plot } = useFrame();
  const legend = data.series.map((s, i) => ({ name: s.name, color: seriesColor(i, s.name) }));
  const viewBox = `0 0 ${frame.width} ${frame.height}`;
  const summary = describe(spec, data);
  const table = categoryTable(title, spec, data);
  if (spec.chartType === "bar") {
    const g = barGeometry(data, { stacked: !!spec.stacked, frame });
    return (
      <Figure title={title} summary={summary} legend={legend} table={table} viewBox={viewBox}>
        <YAxis ticks={g.ticks} spec={spec} scale={yScaleOf(g.ticks, plot)} />
        <g>
          {g.bars.map((bar) => (
            <rect
              key={`${bar.series}-${bar.category}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={Math.min(2, bar.width / 2)}
              fill={legend[bar.series].color}
              stroke={SURFACE}
              strokeWidth={spec.stacked ? 1 : 0}
            >
              <title>{`${data.categories[bar.category]} · ${data.series[bar.series].name}: ${fmt(bar.value, spec)}`}</title>
            </rect>
          ))}
        </g>
        <line
          x1={plot.left}
          x2={plot.right}
          y1={g.zeroY}
          y2={g.zeroY}
          stroke={AXIS}
          aria-hidden="true"
        />
        <XLabels labels={g.xLabels} />
      </Figure>
    );
  }
  const area = spec.chartType === "area";
  const g = lineGeometry(data, { area, stacked: !!spec.stacked, frame });
  return (
    <Figure title={title} summary={summary} legend={legend} table={table} viewBox={viewBox}>
      <YAxis ticks={g.ticks} spec={spec} scale={yScaleOf(g.ticks, plot)} />
      <line
        x1={plot.left}
        x2={plot.right}
        y1={g.zeroY}
        y2={g.zeroY}
        stroke={AXIS}
        aria-hidden="true"
      />
      {g.series.map((s, i) => (
        <g key={data.series[i].name}>
          {s.area && <path d={s.area} fill={legend[i].color} fillOpacity={0.18} stroke="none" />}
          <path
            d={s.path}
            fill="none"
            stroke={legend[i].color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {s.points.map((p) => (
            <circle
              key={p.category}
              cx={p.x}
              cy={p.y}
              r={s.points.length > 24 ? 2 : 4}
              fill={legend[i].color}
              stroke={SURFACE}
              strokeWidth={2}
            >
              <title>{`${data.categories[p.category]} · ${data.series[i].name}: ${fmt(p.value, spec)}`}</title>
            </circle>
          ))}
        </g>
      ))}
      <XLabels labels={g.xLabels} />
    </Figure>
  );
}

function Pie({ spec, title, data }: { spec: ChartSpec; title: string; data: CategoryData }) {
  const series = data.series[0] ?? { name: "", values: [] };
  // Categories past the palette fold into "Other" so slice colors never repeat.
  let labels = data.categories;
  let values = series.values;
  if (labels.length > MAX_SERIES) {
    const rest = values
      .slice(MAX_SERIES - 1)
      .reduce<number>((sum, v) => sum + Math.max(0, v ?? 0), 0);
    labels = [...labels.slice(0, MAX_SERIES - 1), OTHER_LABEL];
    values = [...values.slice(0, MAX_SERIES - 1), rest];
  }
  const slices = pieGeometry(labels, values, {
    cx: 130,
    cy: 130,
    radius: 120,
    inner: spec.chartType === "donut" ? 0.58 : 0,
  });
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const color = (i: number) =>
    slices[i]?.label === OTHER_LABEL && slices[i].index === MAX_SERIES - 1
      ? OTHER_COLOR
      : seriesColor(slices[i]?.index ?? i);
  const summary = `${TYPE_NAMES[spec.chartType]} of ${series.name || "values"} across ${slices.length} ${spec.x ?? "categories"}. Total ${fmt(total, spec)}.`;
  return (
    <Figure
      className="dash-pie"
      title={title}
      summary={summary}
      legend={slices.map((s, i) => ({
        name: `${s.label} (${Math.round(s.fraction * 100)}%)`,
        color: color(i),
      }))}
      viewBox="0 0 260 260"
      table={
        <DataTable
          title={title}
          head={[spec.x || "Category", series.name || "Value", "Share"]}
          rows={slices.map((s) => [
            s.label,
            fmt(s.value, spec),
            `${Math.round(s.fraction * 1000) / 10}%`,
          ])}
        />
      }
    >
      {slices.map((s, i) => (
        <path
          key={s.index}
          d={s.path}
          fill={color(i)}
          stroke={SURFACE}
          strokeWidth={2}
          fillRule="evenodd"
        >
          <title>{`${s.label}: ${fmt(s.value, spec)} (${Math.round(s.fraction * 100)}%)`}</title>
        </path>
      ))}
      {spec.chartType === "donut" && (
        <text
          x={130}
          y={130}
          dy="0.35em"
          textAnchor="middle"
          fill={INK}
          fontSize={20}
          fontWeight={700}
          aria-hidden="true"
        >
          {fmt(total, spec)}
        </text>
      )}
    </Figure>
  );
}

function Scatter({ spec, title, data }: { spec: ChartSpec; title: string; data: ScatterData }) {
  const { frame, plot } = useFrame();
  const g = scatterGeometry(data, frame);
  const legend = data.series.map((s, i) => ({ name: s.name, color: seriesColor(i, s.name) }));
  const count = data.series.reduce((n, s) => n + s.points.length, 0);
  const xScale = (v: number) =>
    g.xTicks.max === g.xTicks.min
      ? plot.left
      : plot.left + ((v - g.xTicks.min) / (g.xTicks.max - g.xTicks.min)) * (plot.right - plot.left);
  const summary = `Scatter plot of ${count} points: ${(spec.y ?? []).join(", ") || "y"} against ${spec.x ?? "x"}.`;
  return (
    <Figure
      title={title}
      summary={summary}
      legend={legend}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      table={
        <DataTable
          title={title}
          head={["Series", spec.x || "x", (spec.y ?? [])[0] || "y"]}
          rows={data.series.flatMap((s) =>
            s.points.map((p) => [s.name, fmt(p.x, spec), fmt(p.y, spec)]),
          )}
        />
      }
    >
      <YAxis ticks={g.yTicks} spec={spec} scale={yScaleOf(g.yTicks, plot)} />
      <g aria-hidden="true">
        <line x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} stroke={AXIS} />
        {g.xTicks.ticks.map((t) => (
          <text
            key={t}
            x={xScale(t)}
            y={plot.bottom + 16}
            textAnchor="middle"
            fill={MUTED}
            fontSize={11}
          >
            {fmt(t, spec)}
          </text>
        ))}
      </g>
      {g.series.map((s, i) => (
        <g key={legend[i].name}>
          {s.points.map((p, j) => (
            <circle
              key={j}
              cx={p.cx}
              cy={p.cy}
              r={4}
              fill={legend[i].color}
              fillOpacity={0.85}
              stroke={SURFACE}
              strokeWidth={1.5}
            >
              <title>{`${legend[i].name}: ${fmt(p.x, spec)}, ${fmt(p.y, spec)}`}</title>
            </circle>
          ))}
        </g>
      ))}
    </Figure>
  );
}

function Summary({ spec, title, data }: { spec: ChartSpec; title: string; data: CategoryData }) {
  const series = data.series[0] ?? { name: "", values: [] };
  const values = series.values;
  const present = values.filter((v): v is number => v !== null);
  const last = present.at(-1) ?? null;
  const previous = present.at(-2) ?? null;
  const delta =
    last !== null && previous !== null ? Number((last - previous).toPrecision(15)) : null;
  const line = sparkline(values, { width: 160, height: 40 });
  const summary = `Latest ${series.name || "value"} ${fmt(last, spec)}${
    delta === null
      ? ""
      : `, ${delta >= 0 ? "up" : "down"} ${fmt(Math.abs(delta), spec)} from the previous value`
  }.${present.length ? ` ${present.length} values from ${fmt(Math.min(...present), spec)} to ${fmt(Math.max(...present), spec)}.` : ""}`;
  return (
    <figure className="dash-chart dash-summary">
      <p className="dash-big" aria-hidden="true">
        {fmt(last, spec)}
      </p>
      {delta !== null && (
        <p className="dash-delta" aria-hidden="true">
          {delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta), spec)} vs previous
        </p>
      )}
      <svg viewBox="0 0 160 40" role="img" aria-label={`${title}. ${summary}`}>
        <title>{title}</title>
        <desc>{summary}</desc>
        <path
          d={line.path}
          fill="none"
          stroke={seriesColor(0)}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {line.last && <circle cx={line.last.x} cy={line.last.y} r={3} fill={seriesColor(0)} />}
      </svg>
      {categoryTable(title, spec, { categories: data.categories, series: [series] })}
    </figure>
  );
}
