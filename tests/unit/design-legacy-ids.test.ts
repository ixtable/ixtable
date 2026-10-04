import { describe, expect, it } from "vitest";
import { hasLegacyIds, upgradeLegacyIds } from "../../src/design/legacyIds";
import type { DocumentConfig } from "../../src/lib/types";

const legacy = () =>
  ({
    version: 3,
    name: "Old",
    activeMode: "design",
    design: {
      version: 3,
      forms: [
        {
          id: "main",
          name: "Main form",
          detailFormId: "main",
          controls: [
            {
              id: "c1",
              kind: "relatedList",
              label: "Lines",
              related: {
                table: "t",
                foreignKey: "p",
                parentColumn: "id",
                columns: [],
                formId: "main",
              },
            },
          ],
        },
        { id: "other", name: "Other", detailFormId: null },
      ],
      navigation: [
        { id: "main", label: "Main form", kind: "form", targetId: "main" },
        {
          id: "g",
          label: "Group",
          kind: "group",
          children: [
            { id: "n2", label: "Again", targetId: "main" },
            { id: "n3", label: "Report", kind: "report", targetId: "main" },
          ],
        },
      ],
      startPage: "main",
    },
    actions: [
      {
        id: "a",
        name: "Open",
        onError: "stop",
        steps: [
          { id: "s1", kind: "openForm", formId: "main" },
          JSON.parse(
            '{"id":"s2","kind":"condition",' +
              '"then":[{"id":"s3","kind":"navigate","target":{"kind":"form","id":"main"}}],' +
              '"else":[{"id":"s4","kind":"navigate","target":{"kind":"report","id":"main"}}]}',
          ),
        ],
      },
    ],
    dashboards: [
      { id: "d", name: "D", components: [{ id: "k", kind: "form", title: "F", formId: "main" }] },
    ],
    roles: [
      {
        id: "r",
        name: "Clerk",
        permissions: {
          navigation: ["main", "g"],
          objects: [
            { kind: "form", id: "main", read: true },
            { kind: "report", id: "main", read: true },
          ],
          actions: [],
        },
      },
    ],
  }) as unknown as DocumentConfig;

const at = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>((item, key) => (item as Record<string | number, unknown>)?.[key], value);

describe("legacy `main` design ids", () => {
  it("rewrites the form and navigation ids and every reference, like the Rust upgrade", () => {
    const ids = ["F", "N"];
    const before = legacy();
    const value = upgradeLegacyIds(before, () => ids.shift() ?? "");
    const expected: Array<[Array<string | number>, unknown]> = [
      [["design", "forms", 0, "id"], "F"],
      [["design", "forms", 0, "detailFormId"], "F"],
      [["design", "forms", 0, "controls", 0, "related", "formId"], "F"],
      [["design", "forms", 1, "id"], "other"],
      [["design", "navigation", 0, "id"], "N"],
      [["design", "navigation", 0, "targetId"], "F"],
      [["design", "navigation", 1, "children", 0, "targetId"], "F"],
      [["design", "navigation", 1, "children", 1, "targetId"], "main"],
      [["design", "startPage"], "N"],
      [["actions", 0, "steps", 0, "formId"], "F"],
      [["actions", 0, "steps", 1, "then", 0, "target", "id"], "F"],
      [["actions", 0, "steps", 1, "else", 0, "target", "id"], "main"],
      [["dashboards", 0, "components", 0, "formId"], "F"],
      [
        ["roles", 0, "permissions", "navigation"],
        ["N", "g"],
      ],
      [["roles", 0, "permissions", "objects", 0, "id"], "F"],
      [["roles", 0, "permissions", "objects", 1, "id"], "main"],
    ];
    for (const [path, want] of expected) expect([path, at(value, ...path)]).toEqual([path, want]);
    expect(at(before, "design", "forms", 0, "id")).toBe("main");
  });

  it("uses UUIDv7 ids by default and leaves current configs untouched", () => {
    const upgraded = upgradeLegacyIds(legacy());
    const form = at(upgraded, "design", "forms", 0, "id");
    expect(form).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(at(upgraded, "design", "startPage")).not.toBe(form);
    expect(hasLegacyIds(upgraded)).toBe(false);
    expect(upgradeLegacyIds(upgraded)).toBe(upgraded);
  });
});
