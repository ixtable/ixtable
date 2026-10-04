import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { createElement } from "react";

// Set before loading the native module: Rust creates its process-wide
// DocumentManager (recent files, recovery sessions) on the first command.
export const stateDirectory = mkdtempSync(join(tmpdir(), `ixtable-screenshot-${process.pid}-`));
process.env.IXTABLE_STATE_DIR = stateDirectory;
const require = createRequire(import.meta.url);
const bridge = require("../src-tauri/target/index.cjs") as {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

/** Native file dialogs: specs queue the path the user would pick. */
export const dialogMock = {
  open: vi.fn<() => Promise<string | null>>(),
  save: vi.fn<() => Promise<string | null>>(),
};
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement("textarea", {
      "aria-label": "SQL editor",
      value,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value() {},
});
if (!globalThis.PointerEvent) globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
// jsdom has no print dialog; report print specs spy on it when they assert it.
window.print = () => undefined;

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  dialogMock.open.mockReset();
  dialogMock.save.mockReset();
  for (const windowLabel of ["main", "seed", "crashy"])
    await bridge.invoke("close_document", { windowLabel, force: true }).catch(() => undefined);
});
afterAll(() => rmSync(stateDirectory, { recursive: true, force: true }));

type Size = { width: number; height: number };
const CANVAS: Size = { width: 1000, height: 300 };
/**
 * Shared grid canvases (forms, dashboards) pick their breakpoint from the
 * measured width. jsdom measures 0, which would select the narrowest layout;
 * report the width of the desktop workspace column instead.
 */
const GRID_CANVAS: Size = { width: 760, height: 480 };

// jsdom exposes no DOMMatrix implementation. React Flow only needs the
// vertical scale from the viewport transform while measuring node internals.
class ScreenshotDOMMatrixReadOnly {
  readonly m22: number;
  constructor(transform = "") {
    const matrix = transform.match(/matrix\([^,]+,[^,]+,[^,]+,\s*([^,)]+)/);
    const scale = transform.match(/scale\(\s*([\d.]+)/);
    this.m22 = Number(matrix?.[1] ?? scale?.[1] ?? 1);
  }
}
Object.defineProperty(window, "DOMMatrixReadOnly", {
  configurable: true,
  value: ScreenshotDOMMatrixReadOnly,
});
Object.defineProperty(SVGElement.prototype, "getBBox", {
  configurable: true,
  value() {
    const text = this.textContent ?? "";
    return { x: 0, y: 0, width: Math.max(1, text.length * 5), height: 10 };
  },
});

/**
 * jsdom does not perform layout. React Flow, however, deliberately waits until
 * both its viewport and every custom node have non-zero dimensions. Keep these
 * measurements narrowly scoped so that a table node is not mistaken for the
 * entire canvas (which also corrupts edge and minimap geometry).
 */
function measuredSize(element: Element): Size {
  if (
    element.matches(
      ".react-flow, .react-flow__renderer, .react-flow__pane, .react-flow__viewport, .flow-browser",
    )
  )
    return CANVAS;
  const table = element.matches(".flow-table")
    ? element
    : element.querySelector(":scope > .flow-table");
  if (element.matches(".react-flow__node") || table) {
    const fields = (table ?? element).querySelectorAll(".flow-field").length;
    return { width: 190, height: 35 + fields * 24 };
  }
  if (element.matches(".react-flow__handle")) return { width: 7, height: 7 };
  if (element.matches(".grid-canvas")) return GRID_CANVAS;
  return { width: 0, height: 0 };
}

const rectFor = (element: Element): DOMRect => {
  const { width, height } = measuredSize(element);
  let left = 0,
    top = 0;
  if (element.matches(".react-flow__handle")) {
    const table = element.closest(".flow-table");
    const field = element.closest(".flow-field");
    const fields = table ? Array.from(table.querySelectorAll(".flow-field")) : [];
    const fieldIndex = field ? Math.max(0, fields.indexOf(field)) : 0;
    left = element.matches(".react-flow__handle-right") ? 190 - width : 0;
    top = 33 + fieldIndex * 24 + (24 - height) / 2;
  }
  const right = left + width,
    bottom = top + height;
  return {
    x: left,
    y: top,
    top,
    left,
    right,
    bottom,
    width,
    height,
    toJSON() {
      return { x: left, y: top, top, left, right, bottom, width, height };
    },
  } as DOMRect;
};

globalThis.ResizeObserver = class ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const contentRect = rectFor(target);
    // Native observers notify after observe() returns. React Flow registers the
    // target in its lookup map during that gap, so a synchronous callback is
    // observed too early and leaves the node permanently uninitialised.
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            contentRect,
            contentBoxSize: [],
            borderBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
};

Object.defineProperties(HTMLElement.prototype, {
  clientWidth: {
    configurable: true,
    get() {
      return measuredSize(this).width;
    },
  },
  clientHeight: {
    configurable: true,
    get() {
      return measuredSize(this).height;
    },
  },
  offsetWidth: {
    configurable: true,
    get() {
      return measuredSize(this).width;
    },
  },
  offsetHeight: {
    configurable: true,
    get() {
      return measuredSize(this).height;
    },
  },
});
HTMLElement.prototype.getBoundingClientRect = function () {
  return rectFor(this);
};
