import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReportDocument } from "../../src/reports/engine";
import { PageView } from "../../src/reports/PageView";
import { writePdf } from "../../src/reports/pdf";

const SRC = join(__dirname, "../../src");

function sourceFiles(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, ext);
    return entry.name.endsWith(ext) ? [path] : [];
  });
}

const stylesheets = sourceFiles(SRC, ".css").map((path) => ({
  path,
  css: readFileSync(path, "utf8"),
}));

type Rule = { selector: string; body: string };
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].split(";").at(-1) ?? "";
    out.push({ selector: selector.trim().replace(/\s+/g, " "), body: match[2] });
  }
  return out;
}

function tokens(): Record<string, string> {
  const root = rules(readFileSync(join(SRC, "styles.css"), "utf8")).find(
    (rule) => rule.selector === ":root",
  );
  const found: Record<string, string> = {};
  for (const match of root?.body.matchAll(/(--ix-[\w-]+):\s*([^;]+);/g) ?? []) {
    found[match[1]] = match[2].trim();
  }
  return found;
}

function luminance(hex: string) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("focus indicators", () => {
  it("never suppresses the outline without a :focus-visible replacement", () => {
    for (const { path, css } of stylesheets) {
      const all = rules(css);
      const replaced = all
        .filter((rule) => rule.selector.includes(":focus-visible") && /outline/.test(rule.body))
        .flatMap((rule) => rule.selector.split(",").map((s) => s.trim()));
      for (const rule of all.filter((r) => /outline(-style)?:\s*(0|none)\b/.test(r.body))) {
        for (const selector of rule.selector.split(",").map((s) => s.trim())) {
          const base = selector.replace(/:focus(-visible|-within)?/g, "");
          expect(
            replaced.some((s) => s.replace(":focus-visible", "") === base),
            `${path}: ${selector} suppresses the outline`,
          ).toBe(true);
        }
      }
    }
  });

  it("uses no Tailwind outline suppression in components", () => {
    for (const path of sourceFiles(SRC, ".tsx"))
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\boutline-(none|0)\b/);
  });

  it("has a global :focus-visible rule built on the focus token", () => {
    const global = rules(readFileSync(join(SRC, "styles.css"), "utf8")).find(
      (rule) => rule.selector.startsWith(":where(") && rule.selector.endsWith(":focus-visible"),
    );
    expect(global?.selector).toMatch(/button/);
    expect(global?.selector).toMatch(/input/);
    expect(global?.body).toMatch(/outline:\s*2px solid var\(--ix-focus\)/);
  });
});

describe("built-in theme contrast (WCAG 2.1 AA)", () => {
  const t = tokens();
  const hex = (value: string) => {
    const name = value.match(/var\((--ix-[\w-]+)\)/)?.[1];
    if (name) return t[name];
    return value.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i)?.[0];
  };
  const onLight = [
    "--ix-text",
    "--ix-muted",
    "--ix-subtle",
    "--ix-accent",
    "--ix-danger",
    "--ix-warning",
    "--ix-link",
  ];
  const lightSurfaces = [
    "--ix-bg",
    "--ix-surface",
    "#f7f7f4",
    "#f7f8f5",
    "#fbfcfa",
    "#f6f7f5",
    "#f8f9f7",
    "#fafafa",
    "#f0f2ef",
    "#eef0ed",
    "#edf1ec",
    "#f9faf8",
    "#f5f7f3",
  ];
  const onDark = ["--ix-on-dark", "--ix-on-dark-muted", "--ix-on-primary"];
  const darkSurfaces = [
    "--ix-sidebar",
    "--ix-primary",
    "#171a17",
    "#2a302a",
    "#343a34",
    "#353b35",
    "#394139",
    "#3a493e",
    "#3a4c3e",
  ];
  const resolve = (name: string) => (name.startsWith("--") ? t[name] : name);
  const text = [
    ...onLight.flatMap((fg) => lightSurfaces.map((bg) => [fg, bg])),
    ...onDark.flatMap((fg) => darkSurfaces.map((bg) => [fg, bg])),
  ];
  const ui: Array<[string, string]> = [
    ["--ix-focus", "--ix-bg"],
    ["--ix-focus", "--ix-surface"],
    ["--ix-focus-on-dark", "--ix-sidebar"],
    ["--ix-primary", "--ix-surface"],
  ];
  const textColor = /(?:^|[;\s])color:\s*([^;]+)/g;

  it.each(text)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ui)("%s on %s is at least 3:1", (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
  it("sets every text colour in app CSS from a token", () => {
    const allowed =
      /^(var\(--ix-[\w-]+\)|transparent|inherit|currentColor|initial|unset)(\s*!important)?$/i;
    for (const { path, css } of stylesheets)
      for (const rule of rules(css))
        for (const match of rule.body.matchAll(textColor))
          expect(match[1].trim(), `${path}: ${rule.selector}`).toMatch(allowed);
  });
  it("passes 4.5:1 wherever a rule sets both a text token and a background", () => {
    for (const { path, css } of stylesheets)
      for (const rule of rules(css)) {
        const fg = [...rule.body.matchAll(textColor)].at(-1)?.[1] ?? "";
        const bg = rule.body.match(/background(?:-color)?:\s*([^;]+)/)?.[1] ?? "";
        if (fg.includes("--ix-disabled") || !hex(fg) || !hex(bg)) continue;
        expect(
          contrast(hex(fg) as string, hex(bg) as string),
          `${path}: ${rule.selector}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
  });
  it("defines no dark theme that would need its own checks", () => {
    expect(stylesheets.some(({ css }) => css.includes("prefers-color-scheme"))).toBe(false);
  });
});

describe("printing without color", () => {
  const doc: ReportDocument = {
    width: 200,
    height: 200,
    diagnostics: [],
    pages: [
      {
        number: 1,
        items: [
          {
            kind: "text",
            componentId: "t",
            x: 1,
            y: 1,
            w: 50,
            h: 10,
            text: "Hi",
            lines: [{ text: "Hi", x: 1, y: 9, width: 10 }],
            fontSize: 9,
            bold: true,
            gray: 0.3,
          },
          { kind: "line", componentId: "l", x: 1, y: 20, w: 50, h: 0, lineWidth: 1, gray: 0.5 },
          {
            kind: "rect",
            componentId: "r",
            x: 1,
            y: 30,
            w: 50,
            h: 20,
            lineWidth: 1,
            gray: 0.2,
            fill: 0.9,
          },
          {
            kind: "image",
            componentId: "i",
            x: 1,
            y: 60,
            w: 20,
            h: 20,
            assetId: "missing",
            mediaType: "image/png",
          },
        ],
      },
    ],
  };

  it("renders report pages in grays only", () => {
    const svg = renderToStaticMarkup(
      <PageView doc={doc} page={doc.pages[0]} label="Page 1" imageUrl={() => undefined} />,
    );
    const colors = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    expect(colors.length).toBeGreaterThan(3);
    for (const color of colors.filter((c) => c !== "none")) {
      const rgb = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
      const hex = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
      const parts = rgb ? rgb.slice(1) : hex ? hex.slice(1) : [];
      expect(parts, color).toHaveLength(3);
      expect(new Set(parts).size, color).toBe(1);
    }
  });

  it("writes PDFs with gray color operators only", () => {
    const pdf = String.fromCharCode(...writePdf(doc, { title: "T", creationDate: "2026-01-01" }));
    expect(pdf).toMatch(/ g\n/);
    expect(pdf).not.toMatch(/\b(rg|RG|k|K|sc|SC|scn|SCN)\b\n/);
  });

  it.each(["reports/reports.css", "runtime/runtime.css", "dashboards/dashboards.css"])(
    "%s has @media print rules",
    (file) => {
      expect(readFileSync(join(SRC, file), "utf8")).toMatch(/@media print\s*\{/);
    },
  );
});
