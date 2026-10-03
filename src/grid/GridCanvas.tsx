import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  layoutToCss,
  movePlacement,
  placementsEqual,
  placementsToCss,
  placementToCss,
  resizePlacement,
  resolveBreakpoint,
  resolvePlacements,
  resolveRegions,
} from "./engine";
import "./grid.css";
import type { GridDelta, GridItemCss, GridLayout, Placement, SpanConstraints } from "./types";

type GridCanvasProps = {
  layout: GridLayout;
  /** Container width in pixels. When omitted the canvas measures itself with ResizeObserver. */
  width?: number;
  /** Design-time mode: items are focusable, selectable and resizable. */
  editable?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onResize?: (id: string, placement: Placement) => void;
  onMove?: (id: string, placement: Placement) => void;
  /** Shows named region outlines. Defaults to `editable`. */
  showRegions?: boolean;
  /** Accessible name of the canvas. */
  label?: string;
  className?: string;
  children?: ReactNode;
};

type GridItemProps = {
  id: string;
  placement: Placement;
  /** Accessible name used by the item and its resize controls. Defaults to `id`. */
  label?: string;
  constraints?: SpanConstraints;
  className?: string;
  children?: ReactNode;
};

type Rendered = { css: GridItemCss; resolved: Placement };

type GridContextValue = {
  layout: GridLayout;
  width?: number;
  editable: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onResize?: (id: string, placement: Placement) => void;
  onMove?: (id: string, placement: Placement) => void;
  rendered: Map<string, Rendered>;
};

const GridContext = createContext<GridContextValue | null>(null);

const ARROWS: Record<string, GridDelta> = {
  ArrowRight: { columns: 1 },
  ArrowLeft: { columns: -1 },
  ArrowDown: { rows: 1 },
  ArrowUp: { rows: -1 },
};

/**
 * Renders a grid layout with CSS Grid. Breakpoints follow the measured (or given) width.
 * Direct `<GridItem>` children are positioned with the engine's wrapping rule applied.
 */
export function GridCanvas({
  layout,
  width,
  editable = false,
  selectedId,
  onSelect,
  onResize,
  onMove,
  showRegions = editable,
  label,
  className,
  children,
}: GridCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number>();

  useEffect(() => {
    const element = ref.current;
    if (width != null || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next != null) setMeasured(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);

  const activeWidth = width ?? measured;
  const items = Children.toArray(children)
    .filter(isValidElement)
    .filter((child) => child.type === GridItem)
    .map((child) => child.props as GridItemProps);
  const placements = items.map((item) => item.placement);
  const css = placementsToCss(layout, placements, activeWidth);
  const resolved = resolvePlacements(layout, placements, activeWidth);
  const rendered = new Map(
    items.map((item, index) => [item.id, { css: css[index], resolved: resolved[index] }]),
  );
  const regions = showRegions
    ? resolveRegions(layout, activeWidth).filter((region) => region.inTemplate)
    : [];

  return (
    <div
      ref={ref}
      className={["grid-canvas", editable ? "editable" : "", className ?? ""].join(" ").trim()}
      style={layoutToCss(layout, { width: activeWidth })}
      role={label ? "group" : undefined}
      aria-label={label}
      data-breakpoint={resolveBreakpoint(layout, activeWidth).index}
    >
      {regions.map((region) => (
        <div
          key={`region-${region.ident}`}
          className="grid-region"
          style={{ gridArea: region.ident }}
          aria-hidden="true"
        >
          {region.name}
        </div>
      ))}
      <GridContext.Provider
        value={{
          layout,
          width: activeWidth,
          editable,
          selectedId,
          onSelect,
          onResize,
          onMove,
          rendered,
        }}
      >
        {children}
      </GridContext.Provider>
    </div>
  );
}

function useGridContext() {
  const context = useContext(GridContext);
  if (!context) throw new Error("GridItem must be rendered inside GridCanvas");
  return context;
}

type Drag = { x: number; y: number; pitchX: number; pitchY: number; start: Placement };

/** One item on a `GridCanvas`. Must be a direct child of the canvas. */
export function GridItem({
  id,
  placement,
  label,
  constraints,
  className,
  children,
}: GridItemProps) {
  const { layout, width, editable, selectedId, onSelect, onResize, onMove, rendered } =
    useGridContext();
  const itemRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<Placement>();
  const name = label ?? id;
  const selected = selectedId === id;
  const current = rendered.get(id);
  const style = preview
    ? placementToCss(preview, layout, width)
    : (current?.css ?? placementToCss(placement, layout, width));

  const resized = (delta: GridDelta) => resizePlacement(placement, delta, layout, constraints);
  const resize = (delta: GridDelta) => {
    const next = resized(delta);
    if (!placementsEqual(next, placement)) onResize?.(id, next);
  };
  const move = (delta: GridDelta) => {
    const next = movePlacement(placement, delta, layout);
    if (!placementsEqual(next, placement)) onMove?.(id, next);
  };
  const canResize = (delta: GridDelta) => !placementsEqual(resized(delta), placement);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = ARROWS[event.key];
    if (event.altKey && delta) {
      event.preventDefault();
      if (event.shiftKey) move(delta);
      else resize(delta);
      return;
    }
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onSelect?.(id);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || !itemRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const box = itemRef.current.getBoundingClientRect();
    const shown = current?.resolved ?? placement;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      pitchX: (box.width + layout.columnGap) / Math.max(1, shown.columnSpan),
      pitchY: (box.height + layout.rowGap) / Math.max(1, shown.rowSpan),
      start: placement,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelect?.(id);
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = {
      columns: state.pitchX > 0 ? Math.round((event.clientX - state.x) / state.pitchX) : 0,
      rows: state.pitchY > 0 ? Math.round((event.clientY - state.y) / state.pitchY) : 0,
    };
    setPreview(resizePlacement(state.start, delta, layout, constraints));
  };
  const endDrag = (commit: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (commit && state && preview && !placementsEqual(preview, state.start))
      onResize?.(id, preview);
    setPreview(undefined);
  };

  const classes = ["grid-item", selected ? "selected" : "", className ?? ""].join(" ").trim();
  if (!editable) {
    return (
      <div className={classes} style={style}>
        {children}
      </div>
    );
  }
  return (
    <div
      ref={itemRef}
      className={classes}
      style={style}
      role="group"
      aria-label={name}
      tabIndex={0}
      data-selected={selected || undefined}
      onClick={() => onSelect?.(id)}
      onKeyDown={onKeyDown}
    >
      {children}
      {selected && (
        <div className="grid-handles" role="toolbar" aria-label={`Resize ${name}`}>
          <button
            type="button"
            aria-label={`Narrow ${name}`}
            title={`Narrow ${name} (Alt+Left)`}
            disabled={!canResize({ columns: -1 })}
            onClick={() => resize({ columns: -1 })}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Widen ${name}`}
            title={`Widen ${name} (Alt+Right)`}
            disabled={!canResize({ columns: 1 })}
            onClick={() => resize({ columns: 1 })}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Make ${name} shorter`}
            title={`Make ${name} shorter (Alt+Up)`}
            disabled={!canResize({ rows: -1 })}
            onClick={() => resize({ rows: -1 })}
          >
            <ArrowUp aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Make ${name} taller`}
            title={`Make ${name} taller (Alt+Down)`}
            disabled={!canResize({ rows: 1 })}
            onClick={() => resize({ rows: 1 })}
          >
            <ArrowDown aria-hidden="true" />
          </button>
        </div>
      )}
      <span
        className="grid-resize-grip"
        aria-hidden="true"
        title={`Drag to resize ${name}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
      />
    </div>
  );
}
