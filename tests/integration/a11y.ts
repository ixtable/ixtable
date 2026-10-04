import axe from "axe-core";
import { expect } from "vitest";

/**
 * Rules jsdom cannot evaluate: it has no layout or computed colors, so
 * color-contrast always reports "incomplete" or false results (contrast is
 * covered by tests/unit/a11y-styles.test.tsx instead), and scrollable-region
 * checks need real scroll sizes.
 */
const DISABLED = {
  "color-contrast": { enabled: false },
  "color-contrast-enhanced": { enabled: false },
  "scrollable-region-focusable": { enabled: false },
};

/** Serious and critical axe violations in `container`, as readable strings. */
export async function axeViolations(container: Element = document.body) {
  const result = await axe.run(container, { rules: DISABLED, resultTypes: ["violations"] });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`);
}

/** Fails with the violation list when axe finds serious or critical problems. */
export async function expectAccessible(container: Element = document.body) {
  expect(await axeViolations(container)).toEqual([]);
}
