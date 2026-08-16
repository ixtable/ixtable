import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const generated = path.resolve(import.meta.dirname, ".generated");
export type CaptureOptions = {
  name: string;
  expectations: string[];
  viewport?: { width: number; height: number };
  selector?: string;
};

const REACT_FLOW_READY_TIMEOUT_MS = 2_000;

function reactFlowState(doc: Document) {
  const flows = Array.from(doc.querySelectorAll(".react-flow"));
  return flows.map((flow) => ({
    nodes: Array.from(flow.querySelectorAll<HTMLElement>(".react-flow__node")),
    edges: Array.from(flow.querySelectorAll<SVGPathElement>(".react-flow__edge-path")),
    minimapNodes: Array.from(flow.querySelectorAll(".react-flow__minimap-node")),
  }));
}

async function waitForReactFlow(doc: Document, timeoutMs = REACT_FLOW_READY_TIMEOUT_MS) {
  if (!doc.querySelector(".react-flow")) return;
  const deadline = Date.now() + timeoutMs;
  let summary = "no nodes or edges";
  while (Date.now() < deadline) {
    const states = reactFlowState(doc);
    const ready = states.every(({ nodes, edges, minimapNodes }) => {
      const visibleNodes = nodes.filter(
        (node) =>
          node.style.visibility !== "hidden" &&
          node.style.opacity !== "0" &&
          node.getBoundingClientRect().width > 0,
      );
      summary = `${visibleNodes.length}/${nodes.length} visible nodes, ${edges.length} edges, ${minimapNodes.length} minimap nodes`;
      return nodes.length > 0 && visibleNodes.length === nodes.length && edges.length > 0;
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for React Flow to initialize before screenshot capture (${summary}).`,
  );
}

export async function captureDocument(
  doc: Document,
  { name, expectations, viewport = { width: 1280, height: 800 }, selector }: CaptureOptions,
) {
  if (!expectations.length || expectations.length > 3)
    throw new Error("A capture needs 1–3 visual expectations.");
  const cssPath = path.join(generated, "app.css");
  if (!fs.existsSync(cssPath))
    throw new Error("Missing screenshot CSS. Run npm run screenshot:css.");
  fs.mkdirSync(generated, { recursive: true });
  await waitForReactFlow(doc);
  const htmlPath = path.join(generated, `${name}.html`);
  const pngPath = path.join(generated, `${name}.png`);
  const snapshot = doc.body.cloneNode(true) as HTMLBodyElement;
  // The detached HTML is rendered at the same fixed canvas dimensions used by
  // jsdom. Preserve the authored node coordinates instead of serializing the
  // transient fitView transform calculated before jsdom's async measurements.
  snapshot.querySelectorAll<HTMLElement>(".react-flow__viewport").forEach((flowViewport) => {
    flowViewport.style.transform = "translate(0px, 0px) scale(1)";
  });
  const liveControls = doc.body.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input,textarea,select");
  const clonedControls = snapshot.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input,textarea,select");
  liveControls.forEach((live, index) => {
    const clone = clonedControls[index];
    if (live instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      clone.setAttribute("value", live.value);
      if (live.checked) clone.setAttribute("checked", "");
      else clone.removeAttribute("checked");
    }
    if (live instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement)
      clone.textContent = live.value;
    if (live instanceof HTMLSelectElement && clone instanceof HTMLSelectElement)
      Array.from(clone.options).forEach((option, i) =>
        option.toggleAttribute("selected", i === live.selectedIndex),
      );
  });
  const html = `<!doctype html><html class="${doc.documentElement.className}"><head><meta charset="utf-8"><style>${fs.readFileSync(cssPath, "utf8")}</style></head><body class="${doc.body.className}">${snapshot.innerHTML}</body></html>`;
  fs.writeFileSync(htmlPath, html);
  const runPath = path.join(generated, "capture-run.json");
  if (!fs.existsSync(runPath))
    throw new Error("Missing screenshot run marker. Run npm run screenshot.");
  const run = JSON.parse(fs.readFileSync(runPath, "utf8")) as { id: string };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(`file://${htmlPath}`);
    if (selector) {
      const element = page.locator(selector);
      if ((await element.count()) !== 1)
        throw new Error(`Screenshot selector ${selector} must match exactly one element.`);
      await element.evaluate((canvas: HTMLElement) => {
        const nodes = Array.from(canvas.querySelectorAll<HTMLElement>(".react-flow__node")).filter(
          (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity) !== 0 &&
              rect.width > 0 &&
              rect.height > 0
            );
          },
        );
        const edges = Array.from(
          canvas.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
        ).filter((edge) => getComputedStyle(edge).display !== "none");
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
          throw new Error(`Screenshot selector is zero-sized (${rect.width}x${rect.height}).`);
        if (nodes.length < 4 || edges.length < 3)
          throw new Error(
            `React Flow capture needs at least four visible nodes and three edges; found ${nodes.length} and ${edges.length}.`,
          );

        // Fit the authored node positions in the actual browser that takes the
        // screenshot. This avoids relying on jsdom's synthetic layout.
        const viewport = canvas.querySelector<HTMLElement>(".react-flow__viewport");
        if (!viewport) throw new Error("React Flow viewport is missing.");
        viewport.style.transform = "translate(0px, 0px) scale(1)";
        const canvasRect = canvas.getBoundingClientRect();
        const bounds = nodes.reduce(
          (box, node) => {
            const nodeRect = node.getBoundingClientRect();
            return {
              left: Math.min(box.left, nodeRect.left - canvasRect.left),
              top: Math.min(box.top, nodeRect.top - canvasRect.top),
              right: Math.max(box.right, nodeRect.right - canvasRect.left),
              bottom: Math.max(box.bottom, nodeRect.bottom - canvasRect.top),
            };
          },
          { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const padding = 32;
        const scale = Math.min(
          (canvasRect.width - padding * 2) / (bounds.right - bounds.left),
          (canvasRect.height - padding * 2) / (bounds.bottom - bounds.top),
          1.4,
        );
        const x =
          (canvasRect.width - (bounds.right - bounds.left) * scale) / 2 - bounds.left * scale;
        const y =
          (canvasRect.height - (bounds.bottom - bounds.top) * scale) / 2 - bounds.top * scale;
        viewport.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      });
      await page.waitForTimeout(100);
      const inside = await element.evaluate((canvas: HTMLElement) => {
        const box = canvas.getBoundingClientRect();
        return Array.from(canvas.querySelectorAll<HTMLElement>(".react-flow__node")).every(
          (node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= box.left - 1 &&
              rect.top >= box.top - 1 &&
              rect.right <= box.right + 1 &&
              rect.bottom <= box.bottom + 1
            );
          },
        );
      });
      if (!inside)
        throw new Error("React Flow fit left one or more nodes outside the capture canvas.");
      await element.screenshot({ path: pngPath });
    } else {
      await page.locator(".flow-browser").evaluateAll((canvases: HTMLElement[]) => {
        for (const canvas of canvases) {
          const nodes = Array.from(
            canvas.querySelectorAll<HTMLElement>(".react-flow__node"),
          ).filter((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          });
          const edges = Array.from(
            canvas.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
          ).filter((edge) => getComputedStyle(edge).display !== "none");
          if (nodes.length < 4 || edges.length < 3)
            throw new Error(
              `Full-page React Flow capture needs four visible nodes and three edges; found ${nodes.length} and ${edges.length}.`,
            );
          const viewport = canvas.querySelector<HTMLElement>(".react-flow__viewport");
          if (!viewport) throw new Error("React Flow viewport is missing.");
          viewport.style.transform = "translate(0px, 0px) scale(1)";
          const canvasRect = canvas.getBoundingClientRect();
          const bounds = nodes.reduce(
            (box, node) => {
              const rect = node.getBoundingClientRect();
              return {
                left: Math.min(box.left, rect.left - canvasRect.left),
                top: Math.min(box.top, rect.top - canvasRect.top),
                right: Math.max(box.right, rect.right - canvasRect.left),
                bottom: Math.max(box.bottom, rect.bottom - canvasRect.top),
              };
            },
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
          );
          const padding = 24;
          const scale = Math.min(
            (canvasRect.width - padding * 2) / (bounds.right - bounds.left),
            (canvasRect.height - padding * 2) / (bounds.bottom - bounds.top),
            1.4,
          );
          const x =
            (canvasRect.width - (bounds.right - bounds.left) * scale) / 2 - bounds.left * scale;
          const y =
            (canvasRect.height - (bounds.bottom - bounds.top) * scale) / 2 - bounds.top * scale;
          viewport.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
          const fitted = nodes.every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= canvasRect.left - 1 &&
              rect.top >= canvasRect.top - 1 &&
              rect.right <= canvasRect.right + 1 &&
              rect.bottom <= canvasRect.bottom + 1
            );
          });
          if (!fitted)
            throw new Error("Full-page React Flow capture left a node outside the canvas.");
        }
      });
      await page.waitForTimeout(100);
      await page.screenshot({ path: pngPath, fullPage: true });
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(generated, `${name}.json`),
    JSON.stringify(
      { name, runId: run.id, capturedAt: new Date().toISOString(), expectations },
      null,
      2,
    ),
  );
  return pngPath;
}
