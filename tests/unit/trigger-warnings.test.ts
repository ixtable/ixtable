import { expect, it } from "vitest";
import type { DocumentConfig } from "../../src/lib/types";
import { userTriggerGaps } from "../../src/runtime/trigger-warnings";

const config = {
  roles: [
    {
      id: "clerk",
      name: "Clerk",
      permissions: {
        navigation: [],
        actions: ["stock"],
        objects: [
          {
            kind: "table",
            id: "inventory",
            read: true,
            create: false,
            update: true,
            delete: false,
          },
        ],
      },
    },
  ],
  actions: [
    {
      id: "stock",
      name: "Stock",
      onError: "stop",
      steps: [
        JSON.parse(
          '{"id":"c","kind":"condition","when":"true",' +
            '"then":[{"id":"u","kind":"updateRecord","table":"inventory","match":"current"}],' +
            '"else":[{"id":"r","kind":"runAction","actionId":"audit"}]}',
        ),
      ],
    },
    {
      id: "audit",
      name: "Audit",
      onError: "stop",
      steps: [{ id: "l", kind: "createRecord", table: "audit_log", values: {} }],
    },
  ],
  triggers: [
    { id: "t-user", name: "User stock", table: "orders", event: "created", actionId: "stock" },
    { id: "t-app", name: "App stock", table: "orders", event: "created", actionId: "stock" },
  ].map((t, i) => ({
    ...t,
    mode: "sync",
    enabled: true,
    maxAttempts: 3,
    backoffMs: 1,
    ...(i === 0 && { runAs: "user" }),
  })),
} as unknown as DocumentConfig;

it("lists the grants a role lacks for user-mode triggers only", () => {
  expect(userTriggerGaps(config, "clerk")).toEqual([
    {
      triggerId: "t-user",
      name: "User stock",
      missing: [`execute action "Audit"`, `create table "audit_log"`],
    },
  ]);
});

it("follows updates of custom-action entities to the action they run", () => {
  const routed = {
    ...config,
    actions: [
      ...config.actions,
      {
        id: "guard",
        name: "Guard",
        onError: "stop",
        steps: [{ id: "g", kind: "createRecord", table: "stock_audit", values: {} }],
      },
    ],
    entities: [{ id: "e", table: "inventory", concurrency: "customAction", actionId: "guard" }],
  } as unknown as DocumentConfig;
  expect(userTriggerGaps(routed, "clerk")[0].missing.sort()).toEqual([
    `create table "audit_log"`,
    `create table "stock_audit"`,
    `execute action "Audit"`,
    `execute action "Guard"`,
  ]);
});
