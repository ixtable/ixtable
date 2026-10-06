import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const sidebars: SidebarsConfig = {
  docsSidebar: [
    "overview",
    {
      type: "category",
      label: "Concepts",
      items: [
        "concepts/data-view",
        "concepts/design-view",
        "concepts/testing",
        "concepts/deployment",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/queries",
        "guides/runtime-forms",
        "guides/reports",
        "guides/dashboards",
        "guides/automation",
        "guides/roles",
        "guides/migrations",
        "guides/runtime-bundles",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: ["reference/expressions"],
    },
    {
      type: "category",
      label: "ixtable Cloud",
      items: ["cloud/getting-started", "cloud/security"],
    },
    {
      type: "category",
      label: "Legal",
      items: ["legal/privacy", "legal/terms"],
    },
  ],
};

export default sidebars;
